type ChipTone = "success" | "warning" | "danger" | "neutral" | "info";

const CHIP_TONE_CLASSES: Record<ChipTone, string> = {
  success: "bg-emerald-100 text-emerald-700",
  warning: "bg-amber-100 text-amber-800",
  danger: "bg-rose-100 text-rose-700",
  neutral: "bg-slate-100 text-slate-700",
  info: "bg-blue-100 text-blue-700",
};

const CHIP_TONE_BORDER_CLASSES: Record<ChipTone, string> = {
  success: "border-emerald-200",
  warning: "border-amber-200",
  danger: "border-rose-200",
  neutral: "border-slate-200",
  info: "border-blue-200",
};

export const chipToneClass = (tone: ChipTone) => CHIP_TONE_CLASSES[tone];
export const chipToneBorderClass = (tone: ChipTone) => CHIP_TONE_BORDER_CLASSES[tone];

export const orderStatusTone = (status?: string | null): ChipTone => {
  const normalized = String(status || "").toUpperCase();
  if (normalized === "PAID") return "success";
  if (normalized === "PARTIALLY_PAID" || normalized === "PENDING_PAYMENT") return "warning";
  if (normalized === "CANCELLED") return "neutral";
  return "danger";
};

export const deliveryStatusTone = (status?: string | null): ChipTone => {
  const normalized = String(status || "").toUpperCase();
  if (normalized === "DELIVERED") return "success";
  if (normalized === "PARTIALLY_DELIVERED") return "warning";
  if (normalized === "RETURNED") return "danger";
  return "neutral";
};

export const paymentStatusTone = (status?: string | null): ChipTone => {
  const normalized = String(status || "").toUpperCase();
  if (["SUCCESS", "PAID", "NORMAL", "COMPLETED"].includes(normalized)) return "success";
  if (["PENDING", "PROCESSING"].includes(normalized)) return "warning";
  if (["FAILED", "CANCELLED", "VOID"].includes(normalized)) return "danger";
  return "neutral";
};

export const stockStatusTone = (stock: number, lowThreshold: number): ChipTone => {
  if (stock <= 0) return "danger";
  if (stock <= lowThreshold) return "warning";
  return "success";
};
