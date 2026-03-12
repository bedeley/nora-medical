import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { isR2Configured, uploadImageToR2 } from "@/lib/r2-storage";
import { isLiveStage } from "@/lib/env";
import { recordAuditLog } from "@/lib/audit-log";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function saveLocalUpload(
  buffer: Buffer,
  ext: ".jpg" | ".jpeg" | ".png" | ".webp",
) {
  const uploadDir = path.join(process.cwd(), "public", "uploads");
  await mkdir(uploadDir, { recursive: true });
  const fileName = `${randomUUID()}${ext}`;
  const filePath = path.join(uploadDir, fileName);
  await writeFile(filePath, buffer, { flag: "wx" });
  return `/uploads/${fileName}`;
}

function detectImageType(buf: Buffer): "jpeg" | "png" | "webp" | "unknown" {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
    return "png";
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return "webp";
  return "unknown";
}

/**
 * Staff image upload with strict validation.
 * In production, prefers Cloudflare R2 when configured; otherwise
 * falls back to saving into /public/uploads and returns { url }.
 */
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      });
    }
    const user = session.user as AuthenticatedUser;
    const role = user.role;
    const isAdmin = role === "ADMIN";
    const isStaff = role === "STAFF";
    const isDispatcher = role === "DISPATCHER";
    if (!isAdmin && !isStaff && !isDispatcher) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
    if (!assertSameOrigin(req)) {
      return new Response(JSON.stringify({ error: "Bad origin" }), { status: 403 });
    }
    const limited = await rateLimit(req, "staff-upload", 60_000, 60);
    if (!limited.ok) {
      return new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return new Response(JSON.stringify({ error: "No file provided" }), { status: 400 });
    }

    const maxBytes = 5 * 1024 * 1024; // 5MB
    if (typeof file.size === "number" && file.size > maxBytes) {
      return new Response(JSON.stringify({ error: "File too large (max 5MB)" }), { status: 400 });
    }

    const allowedMime = ["image/jpeg", "image/png", "image/webp"];
    const mime = file.type || "";
    if (mime && !allowedMime.includes(mime)) {
      return new Response(JSON.stringify({ error: "Unsupported file type" }), { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const kind = detectImageType(buffer);
    if (kind === "unknown") {
      return new Response(JSON.stringify({ error: "Invalid image data" }), { status: 400 });
    }

    const ext = (kind === "jpeg" ? ".jpg" : `.${kind}`) as ".jpg" | ".jpeg" | ".png" | ".webp";

    const logImageUpload = async (payload: { storage: string; url: string }) => {
      try {
        await recordAuditLog({
          actorId: user.id,
          action: "IMAGE_UPLOAD",
          entityType: "PRODUCT_IMAGE",
          entityId: "n/a",
          meta: {
            mime,
            size: file.size,
            ext,
            filename: (file as File & { name?: string }).name || null,
            storage: payload.storage,
            url: payload.url,
            uploadedAt: new Date().toISOString(),
            actorName: user.name || null,
            actorEmail: user.email || null,
            actorRole: user.role || null,
            resultSummary: `Uploaded image to ${payload.storage}.`,
          },
        });
      } catch {
        // ignore audit errors
      }
    };

    // Prefer Cloudflare R2 when configured (required for production)
    if (isR2Configured()) {
      const uploaded = await uploadImageToR2(buffer, ext);
      if (!uploaded.ok) {
        console.error("R2 upload error:", uploaded.error);
        if (isLiveStage()) {
          return new Response(
            JSON.stringify({
              error:
                "Upload failed. Verify R2 connectivity and credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL).",
            }),
            { status: 500 },
          );
        }
        // In local/UAT, tolerate transient R2/DNS outages and fallback to local uploads.
        const localUrl = await saveLocalUpload(buffer, ext);
        await logImageUpload({ storage: "local-fallback", url: localUrl });
        return new Response(JSON.stringify({ url: localUrl, storage: "local-fallback" }), { status: 200 });
      }
      await logImageUpload({ storage: "r2", url: uploaded.url });
      return new Response(JSON.stringify({ url: uploaded.url }), { status: 200 });
    }

    // In production/live, do not allow filesystem fallback because Vercel is read-only
    if (isLiveStage()) {
      return new Response(
        JSON.stringify({
          error: "Uploads are not configured. Set R2 env vars (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL).",
        }),
        { status: 500 }
      );
    }

    // Fallback: local filesystem (useful for local dev without Supabase)
    const url = await saveLocalUpload(buffer, ext);
    await logImageUpload({ storage: "local", url });
    return new Response(JSON.stringify({ url }), { status: 200 });
  } catch (err) {
    console.error("Upload error:", err);
    return new Response(JSON.stringify({ error: "Upload failed" }), {
      status: 500,
    });
  }
}
