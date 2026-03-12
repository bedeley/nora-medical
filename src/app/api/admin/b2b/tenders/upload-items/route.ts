import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { extractTextFromPdfBuffer } from "@/lib/pdf-text-extract";
import { extractTextWithOcrSpace } from "@/lib/ocr";
import { sanitizeTenderItemsText } from "@/lib/tender-sanitization";
import { extractTextFromDocxBuffer } from "@/lib/docx-text-extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const allowedTypes = new Set([
  "text/plain",
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function looksLikeText(buffer: Buffer) {
  // Reject obvious binary by checking NUL bytes.
  for (let i = 0; i < Math.min(buffer.length, 4096); i += 1) {
    if (buffer[i] === 0x00) return false;
  }
  return true;
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-b2b-tender-upload-items", 60_000, 20);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (file.size > 2 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 2MB)" }, { status: 400 });
  }
  if (file.type && !allowedTypes.has(file.type)) {
    return NextResponse.json({ error: "Only TXT/CSV/PDF/DOCX/DOC uploads are supported in this version." }, { status: 400 });
  }

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);
  const isPdf =
    file.type === "application/pdf" ||
    String((file as File & { name?: string }).name || "").toLowerCase().endsWith(".pdf");
  const isDocx =
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    String((file as File & { name?: string }).name || "").toLowerCase().endsWith(".docx");
  const isDoc =
    file.type === "application/msword" ||
    String((file as File & { name?: string }).name || "").toLowerCase().endsWith(".doc");
  const isImage = file.type.startsWith("image/");
  const fileName = (file as File & { name?: string }).name || "upload";
  const ocrEnabled = (process.env.B2B_TENDER_OCR_ENABLE || "").trim() === "1";

  let text = "";
  if (isPdf) {
    text = extractTextFromPdfBuffer(buffer);
    if ((!text || text.length < 10) && ocrEnabled) {
      const ocr = await extractTextWithOcrSpace({
        buffer,
        filename: fileName,
        mimeType: file.type || "application/pdf",
      });
      if (ocr.ok && ocr.text) text = ocr.text;
    }
    if (!text || text.length < 10) {
      const msg = ocrEnabled
        ? "Could not extract enough text from this PDF (including OCR). Use a clearer file or paste the items."
        : "Could not extract enough text from this PDF. Enable OCR or use TXT/CSV/paste.";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  } else if (isDocx) {
    text = extractTextFromDocxBuffer(buffer);
    if (!text || text.length < 10) {
      return NextResponse.json(
        { error: "Could not extract enough text from this DOCX. Use a clearer DOCX, or paste TXT/CSV items." },
        { status: 400 },
      );
    }
  } else if (isDoc) {
    return NextResponse.json(
      { error: "Legacy .doc is not supported for automatic extraction. Convert to DOCX or PDF." },
      { status: 400 },
    );
  } else if (isImage) {
    if (!ocrEnabled) {
      return NextResponse.json(
        { error: "Image upload needs OCR enabled. Set B2B_TENDER_OCR_ENABLE=1 and OCR_SPACE_API_KEY." },
        { status: 400 },
      );
    }
    const ocr = await extractTextWithOcrSpace({
      buffer,
      filename: fileName,
      mimeType: file.type || "image/png",
    });
    if (!ocr.ok || !ocr.text) {
      return NextResponse.json({ error: ocr.error || "OCR failed for image" }, { status: 400 });
    }
    text = ocr.text;
  } else {
    if (!looksLikeText(buffer)) {
      return NextResponse.json({ error: "Unsupported file content. Use TXT/CSV/PDF." }, { status: 400 });
    }
    text = buffer.toString("utf8").trim();
  }

  if (!text) return NextResponse.json({ error: "File is empty" }, { status: 400 });
  const sanitized = sanitizeTenderItemsText(text);
  if (!sanitized.text || sanitized.lineCount === 0) {
    return NextResponse.json({ error: "No valid item lines found after sanitization" }, { status: 400 });
  }

  return NextResponse.json({ ok: true, itemsText: sanitized.text });
}
