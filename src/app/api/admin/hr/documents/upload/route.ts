import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { isR2Configured, uploadPrivateFileToR2 } from "@/lib/r2-storage";
import { isLiveStage } from "@/lib/env";
import { recordAuditLog } from "@/lib/audit-log";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const allowedTypes = new Map<string, string>([
  ["application/pdf", ".pdf"],
  ["application/msword", ".doc"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

function extFromName(name: string) {
  const match = name.toLowerCase().match(/\.[a-z0-9]+$/);
  if (!match) return "";
  return match[0];
}

function detectFileType(buffer: Buffer): ".pdf" | ".doc" | ".docx" | ".jpg" | ".png" | ".webp" | "unknown" {
  if (buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return ".pdf";
  }
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
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) && (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08)) {
    return ".docx";
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
  )
    return ".png";
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
  )
    return ".webp";
  return "unknown";
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
    const user = session.user as AuthenticatedUser;
    if (user.role !== "ADMIN") {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
    if (!assertSameOrigin(req)) {
      return new Response(JSON.stringify({ error: "Bad origin" }), { status: 403 });
    }
    const limited = await rateLimit(req, "hr-doc-upload", 60_000, 60);
    if (!limited.ok) {
      return new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return new Response(JSON.stringify({ error: "No file provided" }), { status: 400 });
    }

    const maxBytes = 10 * 1024 * 1024; // 10MB
    if (typeof file.size === "number" && file.size > maxBytes) {
      return new Response(JSON.stringify({ error: "File too large (max 10MB)" }), { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const detected = detectFileType(buffer);
    if (detected === "unknown") {
      return new Response(JSON.stringify({ error: "Invalid file data" }), { status: 400 });
    }

    const extByMime = allowedTypes.get(file.type || "");
    const extByName = extFromName((file as File & { name?: string }).name || "");
    const ext = extByMime || extByName || detected;
    if (!ext || ![...allowedTypes.values()].includes(ext)) {
      return new Response(JSON.stringify({ error: "Unsupported file type" }), { status: 400 });
    }

    if (extByMime && extByMime !== detected) {
      return new Response(JSON.stringify({ error: "File type does not match content" }), { status: 400 });
    }
    if (extByName && extByName !== detected) {
      return new Response(JSON.stringify({ error: "File extension does not match content" }), { status: 400 });
    }

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_DOCUMENT_UPLOAD",
        entityType: "EMPLOYEE_DOCUMENT",
        entityId: "n/a",
        meta: {
          mime: file.type || null,
          size: file.size,
          ext,
          filename: (file as File & { name?: string }).name || null,
        },
      });
    } catch {
      // ignore audit errors
    }

    if (isR2Configured()) {
      const uploaded = await uploadPrivateFileToR2(
        buffer,
        ext as ".pdf" | ".doc" | ".docx" | ".jpg" | ".png" | ".webp",
        "hr-docs"
      );
      if (!uploaded.ok) {
        console.error("R2 upload error:", uploaded.error);
        return new Response(JSON.stringify({ error: "Upload failed" }), { status: 500 });
      }
      return new Response(JSON.stringify({ key: `r2://${uploaded.key}` }), { status: 200 });
    }

    if (isLiveStage()) {
      return new Response(
        JSON.stringify({
          error:
            "Uploads are not configured. Set R2 env vars (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL).",
        }),
        { status: 500 }
      );
    }

    const uploadDir = path.join(process.cwd(), "public", "uploads", "hr-docs");
    await mkdir(uploadDir, { recursive: true });
    const fileName = `${randomUUID()}${ext}`;
    const filePath = path.join(uploadDir, fileName);

    await writeFile(filePath, buffer, { flag: "wx" });

    const key = `/uploads/hr-docs/${fileName}`;
    return new Response(JSON.stringify({ key }), { status: 200 });
  } catch (err) {
    console.error("Document upload error:", err);
    return new Response(JSON.stringify({ error: "Upload failed" }), { status: 500 });
  }
}
