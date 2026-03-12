import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { isLiveStage } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { isR2Configured, uploadFileToR2 } from "@/lib/r2-storage";
import { isCustomerB2B } from "@/lib/customer-profile";
import { extractTextFromPdfBuffer } from "@/lib/pdf-text-extract";
import { extractTextWithOcrSpace } from "@/lib/ocr";
import { sanitizeTenderItemsText } from "@/lib/tender-sanitization";
import { extractTextFromDocxBuffer } from "@/lib/docx-text-extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const allowedTypes = new Map<string, string>([
  ["application/pdf", ".pdf"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["application/msword", ".doc"],
]);

function extFromName(name: string) {
  const match = name.toLowerCase().match(/\.[a-z0-9]+$/);
  if (!match) return "";
  return match[0];
}

function detectFileType(buffer: Buffer): ".pdf" | ".jpg" | ".png" | ".webp" | ".docx" | ".doc" | "unknown" {
  if (buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return ".pdf";
  }
  // ZIP magic used by .docx
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    return ".docx";
  }
  // CFB magic used by legacy .doc
  if (
    buffer.length >= 8 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0 &&
    buffer[4] === 0xa1 &&
    buffer[5] === 0xb1 &&
    buffer[6] === 0x1a &&
    buffer[7] === 0xe1
  ) {
    return ".doc";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return ".png";
  }
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return ".webp";
  }
  return "unknown";
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "account-procurement-po-upload", 60_000, 20);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const user = session.user as AuthenticatedUser;
  if (!(await isCustomerB2B(user.id))) {
    return NextResponse.json({ error: "PO upload is enabled for B2B customer profiles only." }, { status: 403 });
  }
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const maxBytes = 10 * 1024 * 1024;
    if (typeof file.size === "number" && file.size > maxBytes) {
      return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const detected = detectFileType(buffer);
    if (detected === "unknown") {
      return NextResponse.json({ error: "Invalid file data" }, { status: 400 });
    }

    const extByMime = allowedTypes.get(file.type || "");
    const extByName = extFromName((file as File & { name?: string }).name || "");
    const ext = extByMime || extByName || detected;
    if (!ext || ![...allowedTypes.values()].includes(ext)) {
      return NextResponse.json({ error: "Unsupported file type" }, { status: 400 });
    }
    if (extByMime && extByMime !== detected) {
      return NextResponse.json({ error: "File type does not match content" }, { status: 400 });
    }
    if (extByName && extByName !== detected) {
      return NextResponse.json({ error: "File extension does not match content" }, { status: 400 });
    }

    const fileName = (file as File & { name?: string }).name || `po-${randomUUID()}${ext}`;
    const isPdf = ext === ".pdf";
    const isDocx = ext === ".docx";
    const isDoc = ext === ".doc";
    const isImage = ext === ".jpg" || ext === ".png" || ext === ".webp";
    const ocrEnabled = (process.env.B2B_TENDER_OCR_ENABLE || "").trim() === "1";
    let extractedItemsText: string | null = null;
    let extractionMessage: string | null = null;
    try {
      let extractedRaw = "";
      if (isPdf) {
        extractedRaw = extractTextFromPdfBuffer(buffer);
        if ((!extractedRaw || extractedRaw.length < 10) && ocrEnabled) {
          const ocr = await extractTextWithOcrSpace({
            buffer,
            filename: fileName,
            mimeType: file.type || "application/pdf",
          });
          if (ocr.ok && ocr.text) extractedRaw = ocr.text;
        }
      } else if (isDocx) {
        extractedRaw = extractTextFromDocxBuffer(buffer);
      } else if (isDoc) {
        extractionMessage = "PO uploaded. Legacy .doc files do not support automatic item extraction; please review/fill Items manually.";
      } else if (isImage && ocrEnabled) {
        const ocr = await extractTextWithOcrSpace({
          buffer,
          filename: fileName,
          mimeType: file.type || "image/png",
        });
        if (ocr.ok && ocr.text) extractedRaw = ocr.text;
      }

      if (extractedRaw && extractedRaw.trim()) {
        const sanitized = sanitizeTenderItemsText(extractedRaw);
        if (sanitized.text && sanitized.lineCount > 0) {
          extractedItemsText = sanitized.text;
        } else {
          extractionMessage = "PO uploaded, but no structured item lines were detected.";
        }
      } else if (isImage && !ocrEnabled) {
        extractionMessage = "PO uploaded. OCR is disabled, so item extraction was skipped.";
      } else {
        extractionMessage = "PO uploaded, but item extraction was not successful.";
      }
    } catch {
      extractionMessage = "PO uploaded, but item extraction failed.";
    }

    if (isR2Configured()) {
      const uploaded = await uploadFileToR2(
        buffer,
        ext as ".pdf" | ".jpg" | ".png" | ".webp" | ".docx" | ".doc",
        "uploads/procurement-po",
      );
      if (!uploaded.ok) {
        return NextResponse.json({ error: uploaded.error || "Upload failed" }, { status: 500 });
      }
      await recordAuditLog({
        actorId: user.id,
        action: "B2B_PROCUREMENT_PO_UPLOAD",
        entityType: "B2B_PROCUREMENT_ASSET",
        entityId: `po-${randomUUID()}`,
        meta: {
          url: uploaded.url,
          mime: file.type || null,
          size: file.size,
          filename: (file as File & { name?: string }).name || null,
        },
      });
      return NextResponse.json({
        ok: true,
        url: uploaded.url,
        itemsText: extractedItemsText || undefined,
        extractionMessage: extractionMessage || undefined,
      });
    }

    if (isLiveStage()) {
      return NextResponse.json(
        {
          error:
            "Uploads are not configured. Set R2 env vars to enable procurement PO uploads.",
        },
        { status: 500 },
      );
    }

    const uploadDir = path.join(process.cwd(), "public", "uploads", "procurement-po");
    await mkdir(uploadDir, { recursive: true });
    const localFileName = `${randomUUID()}${ext}`;
    const filePath = path.join(uploadDir, localFileName);
    await writeFile(filePath, buffer, { flag: "wx" });
    const url = `/uploads/procurement-po/${localFileName}`;

    await recordAuditLog({
      actorId: user.id,
      action: "B2B_PROCUREMENT_PO_UPLOAD",
      entityType: "B2B_PROCUREMENT_ASSET",
      entityId: `po-${randomUUID()}`,
      meta: {
        url,
        mime: file.type || null,
        size: file.size,
        filename: (file as File & { name?: string }).name || null,
      },
    });

    return NextResponse.json({
      ok: true,
      url,
      itemsText: extractedItemsText || undefined,
      extractionMessage: extractionMessage || undefined,
    });
  } catch (error) {
    console.error("Procurement PO upload failed:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
