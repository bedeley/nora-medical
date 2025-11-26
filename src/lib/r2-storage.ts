import { randomUUID } from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

type UploadResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

function looksUnconfigured(value: string | undefined | null) {
  const v = (value || "").trim();
  if (!v) return true;
  const lower = v.toLowerCase();
  return (
    lower.includes("example") ||
    lower.includes("your-account-id") ||
    lower.includes("xxxx") ||
    lower.startsWith("env(")
  );
}

export function isR2Configured() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return false;
  if (
    looksUnconfigured(accountId) ||
    looksUnconfigured(accessKeyId) ||
    looksUnconfigured(secretAccessKey) ||
    looksUnconfigured(bucket)
  ) {
    return false;
  }
  return true;
}

function getR2Client() {
  const accountId = (process.env.R2_ACCOUNT_ID || "").trim();
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || "").trim();

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 storage not configured");
  }

  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

function contentTypeForExt(ext: string) {
  switch (ext.toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

export async function uploadImageToR2(
  buffer: Buffer,
  ext: ".jpg" | ".jpeg" | ".png" | ".webp"
): Promise<UploadResult> {
  const bucket = (process.env.R2_BUCKET_NAME || "").trim();
  if (!bucket) {
    return { ok: false, error: "R2 bucket not configured" };
  }

  const key = `uploads/${randomUUID()}${ext}`;

  try {
    const client = getR2Client();
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentTypeForExt(ext),
    });
    await client.send(command);

    const accountId = (process.env.R2_ACCOUNT_ID || "").trim();
    const publicBase = (process.env.R2_PUBLIC_BASE_URL || "").trim();

    const url =
      publicBase ||
      (accountId ? `https://${bucket}.${accountId}.r2.cloudflarestorage.com` : "") ||
      "";

    if (!url) {
      return { ok: false, error: "Could not construct R2 public URL" };
    }

    const fullUrl = `${url.replace(/\/$/, "")}/${key}`;
    return { ok: true, url: fullUrl };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "R2 upload failed",
    };
  }
}
