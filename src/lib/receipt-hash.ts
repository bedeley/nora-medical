import { createHash, createHmac } from "crypto";

export function computeReceiptHash(payload: Record<string, unknown>) {
  const raw = JSON.stringify(payload);
  const secret =
    process.env.RECEIPT_HASH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.AUTH_SECRET ||
    "";
  if (!secret) {
    return createHash("sha256").update(raw).digest("hex");
  }
  return createHmac("sha256", secret).update(raw).digest("hex");
}
