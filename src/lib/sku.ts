export function normalizeSkuPrefix(name: string, length = 3) {
  const cleaned = String(name || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const base = cleaned.slice(0, length);
  return (base || "SKU").padEnd(length, "X");
}

export function formatSku(prefix: string, numberValue: number, minDigits = 3) {
  const width = Math.max(minDigits, String(numberValue).length);
  const suffix = String(numberValue).padStart(width, "0");
  return `${prefix}-${suffix}`;
}

export function parseSkuNumber(prefix: string, sku?: string | null) {
  if (!sku) return null;
  const normalized = String(sku).toUpperCase().trim();
  if (!normalized.startsWith(`${prefix}-`)) return null;
  const raw = normalized.slice(prefix.length + 1);
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}
