import { randomUUID } from "crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";

type UploadResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

const RETRYABLE_NETWORK_ERRORS = [
  "EAI_AGAIN",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
];

function isRetryableR2Error(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return RETRYABLE_NETWORK_ERRORS.some((code) => message.includes(code));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    case ".pdf":
      return "application/pdf";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      return "application/octet-stream";
  }
}

async function putObjectWithRetry(args: {
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
}) {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const client = getR2Client();
      const command = new PutObjectCommand({
        Bucket: args.bucket,
        Key: args.key,
        Body: args.body,
        ContentType: args.contentType,
      });
      await client.send(command);
      return;
    } catch (error: unknown) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableR2Error(error)) {
        throw error;
      }
      await sleep(250 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("R2 upload failed");
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
    await putObjectWithRetry({
      bucket,
      key,
      body: buffer,
      contentType: contentTypeForExt(ext),
    });

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

export async function uploadFileToR2(
  buffer: Buffer,
  ext: ".jpg" | ".jpeg" | ".png" | ".webp" | ".pdf" | ".doc" | ".docx",
  prefix = "uploads"
): Promise<UploadResult> {
  const bucket = (process.env.R2_BUCKET_NAME || "").trim();
  if (!bucket) {
    return { ok: false, error: "R2 bucket not configured" };
  }

  const safePrefix = prefix.replace(/^\/+|\/+$/g, "") || "uploads";
  const key = `${safePrefix}/${randomUUID()}${ext}`;

  try {
    await putObjectWithRetry({
      bucket,
      key,
      body: buffer,
      contentType: contentTypeForExt(ext),
    });

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

export async function uploadPrivateFileToR2(
  buffer: Buffer,
  ext: ".jpg" | ".jpeg" | ".png" | ".webp" | ".pdf" | ".doc" | ".docx",
  prefix = "uploads"
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  const bucket = (process.env.R2_BUCKET_NAME || "").trim();
  if (!bucket) {
    return { ok: false, error: "R2 bucket not configured" };
  }

  const safePrefix = prefix.replace(/^\/+|\/+$/g, "") || "uploads";
  const key = `${safePrefix}/${randomUUID()}${ext}`;

  try {
    await putObjectWithRetry({
      bucket,
      key,
      body: buffer,
      contentType: contentTypeForExt(ext),
    });
    return { ok: true, key };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "R2 upload failed",
    };
  }
}

export async function downloadFileFromR2(key: string): Promise<
  | {
      ok: true;
      body: ReadableStream<Uint8Array>;
      contentType: string | null;
      contentLength: number | null;
    }
  | { ok: false; error: string }
> {
  const bucket = (process.env.R2_BUCKET_NAME || "").trim();
  if (!bucket) {
    return { ok: false, error: "R2 bucket not configured" };
  }

  try {
    const client = getR2Client();
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const res = await client.send(command);
    if (!res.Body) {
      return { ok: false, error: "R2 object missing body" };
    }
    const body =
      res.Body instanceof Readable
        ? Readable.toWeb(res.Body) as ReadableStream<Uint8Array>
        : (res.Body as ReadableStream<Uint8Array>);
    return {
      ok: true,
      body,
      contentType: res.ContentType || null,
      contentLength: typeof res.ContentLength === "number" ? res.ContentLength : null,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "R2 download failed",
    };
  }
}
