import { createHash } from "crypto";

export function computeReceiptHash(payload: Record<string, unknown>) {
  const raw = JSON.stringify(payload);
  return createHash("sha256").update(raw).digest("hex");
}
