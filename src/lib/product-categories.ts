export const PRODUCT_CATEGORIES = [
  "diagnostics",
  "mobility",
  "ppe-safety",
  "equipment",
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export const PRODUCT_CATEGORY_LABELS: Record<ProductCategory, string> = {
  diagnostics: "Diagnostics",
  mobility: "Mobility",
  "ppe-safety": "PPE & Safety",
  equipment: "Equipment",
};

export const PRODUCT_CATEGORY_OPTIONS = PRODUCT_CATEGORIES.map((value) => ({
  value,
  label: PRODUCT_CATEGORY_LABELS[value],
}));
