import { z } from "zod";
import { PRODUCT_CATEGORIES } from "@/lib/product-categories";

export function toTitleCase(str: string) {
  return String(str || "").replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

const imageUrlOrPath = z
  .string()
  .refine(
    (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return typeof value === "string" && value.startsWith("/");
      }
    },
    { message: "Upload an image or provide https://... or a site path like /images/..." },
  );

const categoryEnum = z.preprocess(
  (value) => (value == null ? "" : String(value)),
  z
    .string()
    .min(1, "You must select a category.")
    .refine(
      (value) => PRODUCT_CATEGORIES.includes(value as (typeof PRODUCT_CATEGORIES)[number]),
      { message: "Please select a valid category." },
    ),
);

const optionalPercent = z.preprocess(
  (value) => {
    if (value == null || value === "") return undefined;
    const num = Number(value);
    return Number.isFinite(num) ? num : value;
  },
  z.number().min(0, "Minimum margin must be 0% or higher.").max(100, "Maximum is 100%.").optional(),
);

export const productSchema = z
  .object({
    name: z.string().min(2, "Name is required"),
    description: z.string().min(5, "Description too short"),
    imageUrl: imageUrlOrPath,
    category: categoryEnum,
    brand: z.string().min(2, "Brand is required"),
    supplier: z.string().min(2, "Supplier is required").optional(),
    supplierId: z.string().optional().nullable(),
    minMarginPct: optionalPercent,
    marginOverrideReason: z.string().min(5).optional(),
    price: z.coerce.number().nonnegative("Invalid price"),
    cost: z.coerce.number().positive("Cost must be greater than 0"),
    stock: z.coerce.number().int().nonnegative("Invalid stock"),
    receiveNow: z.boolean().optional(),
    paidOnReceipt: z.boolean().optional(),
    paymentMethod: z.enum(["cash", "transfer", "bank", "credit"]).optional(),
    lotCode: z.string().optional(),
    expiryDate: z.string().optional(),
    requiresLotTracking: z.boolean().optional(),
    requiresExpiryDate: z.boolean().optional(),
  })
  .refine(
    (data) => Boolean(data.supplierId) || Boolean(data.supplier && data.supplier.trim()),
    { message: "Supplier is required", path: ["supplier"] },
  )
  .refine(
    (data) => !data.supplier || data.supplier.trim().toLowerCase() !== "unknown",
    { message: "Please enter a real supplier.", path: ["supplier"] },
  )
  .refine(
    (data) => !data.requiresExpiryDate || data.requiresLotTracking,
    { message: "Expiry date tracking requires lot tracking.", path: ["requiresExpiryDate"] },
  );

const urlOrPath = z
  .string()
  .refine(
    (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return typeof value === "string" && value.startsWith("/");
      }
    },
    { message: "Enter a valid URL or /path" },
  );

export const productEditSchema = z
  .object({
    name: z.string().min(2).optional(),
    description: z.string().min(5).optional(),
    imageUrl: urlOrPath.optional(),
    category: categoryEnum.optional(),
    brand: z.string().min(2).optional(),
    supplier: z.string().min(2).optional(),
    supplierId: z.string().optional().nullable(),
    minMarginPct: optionalPercent,
    marginOverrideReason: z.string().min(5).optional(),
    price: z.coerce.number().nonnegative().optional(),
    stock: z.coerce.number().int().nonnegative().optional(),
    requiresLotTracking: z.boolean().optional(),
    requiresExpiryDate: z.boolean().optional(),
    editReason: z.string().min(5, "Please add a brief reason for this change."),
  })
  .refine(
    (data) => Boolean(data.supplierId) || Boolean(data.supplier && data.supplier.trim()),
    { message: "Supplier is required", path: ["supplier"] },
  )
  .refine(
    (data) => !data.supplier || data.supplier.trim().toLowerCase() !== "unknown",
    { message: "Please enter a real supplier.", path: ["supplier"] },
  )
  .refine(
    (data) => !data.requiresExpiryDate || data.requiresLotTracking,
    { message: "Expiry date tracking requires lot tracking.", path: ["requiresExpiryDate"] },
  );
