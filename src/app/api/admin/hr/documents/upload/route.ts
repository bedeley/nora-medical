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
import {
  detectFileType,
  resolveAndValidateDocumentExt,
} from "@/lib/hr-document-upload-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


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
    const employeeId = String(formData.get("employeeId") || "").trim();
    const sourcePage = String(formData.get("sourcePage") || "").trim() || "admin/hr/staff/[id]";
    const section = String(formData.get("section") || "").trim() || "documents";
    const operation = String(formData.get("operation") || "").trim() || "upload_document_file";
    const resultSummary =
      String(formData.get("resultSummary") || "").trim() || "Document file uploaded successfully.";
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

    const extResolution = resolveAndValidateDocumentExt({
      mimeType: file.type || "",
      fileName: (file as File & { name?: string }).name || "",
      detectedExt: detected,
    });
    if (!extResolution.ok) {
      return new Response(JSON.stringify({ error: extResolution.error }), { status: 400 });
    }
    const ext = extResolution.ext;

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_DOCUMENT_UPLOAD",
        entityType: "EMPLOYEE_DOCUMENT",
        entityId: "n/a",
        meta: {
          actor: {
            id: user.id,
            role: user.role,
          },
          page: sourcePage,
          sourcePage,
          section,
          operation,
          before: null,
          after: {
            employeeId: employeeId || null,
            mime: file.type || null,
            size: file.size,
            ext,
            filename: (file as File & { name?: string }).name || null,
          },
          status: "SUCCESS",
          resultSummary,
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
