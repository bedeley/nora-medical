import { z } from "zod";

/**
 * Shared password validation schema.
 * Enforces minimum 10 characters with complexity requirements:
 * at least 1 uppercase, 1 lowercase, 1 digit, and 1 special character.
 */
export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[0-9]/, "Password must contain at least one digit")
  .regex(
    /[^A-Za-z0-9]/,
    "Password must contain at least one special character"
  );

const optionalEmail = z
  .string()
  .trim()
  .transform((val) => (val === "" ? undefined : val.toLowerCase()))
  .optional();

const optionalUsername = z
  .string()
  .trim()
  .transform((val) => (val === "" ? undefined : val.toLowerCase()))
  .optional();

export const registerSchema = z
  .object({
    name: z.string().trim().min(2),
    email: optionalEmail,
    username: optionalUsername,
    password: passwordSchema,
    phone: z
      .string()
      .trim()
      .refine((val) => {
        if (typeof val !== "string") return false;
        const numeric = val.replace(/[^\d]/g, "");
        return numeric.length >= 7;
      }, "Enter a valid phone number"),
  })
  .refine(
    (data) => Boolean(data.email) || Boolean(data.username),
    {
      message: "Provide either an email or a username.",
      path: ["email"],
    }
  );

export const productSchema = z.object({
  name: z.string().min(2),
  description: z.string().min(4),
  price: z.coerce.number().positive(),
  imageUrl: z.string().url().optional(),
  stock: z.coerce.number().int().nonnegative(),
});

export const paymentSchema = z.object({
  userId: z.string(),
  orderId: z.string().optional(),
  amount: z.coerce.number().refine((v) => v !== 0, {
    message: "Amount cannot be zero",
  }),
  note: z.string().optional(),
  method: z.enum(["cash", "card", "transfer", "momo", "adjustment"]).optional(),
  reference: z.string().optional(),
  receivedBy: z.string().optional(),
  location: z.string().optional(),
  status: z.enum(["normal", "refund", "void"]).optional(),
  refundDisposition: z.enum(["cash", "credit"]).optional(),
}).refine(
  (data) => data.status !== "refund" || !!data.refundDisposition,
  { message: "Select how to handle the refund", path: ["refundDisposition"] }
).refine(
  (data) => {
    const status = (data.status || "").toLowerCase();
    if (status !== "refund" && status !== "void") return true;
    const note = String(data.note || "").trim();
    return note.length >= 5;
  },
  { message: "Please provide a brief reason for refunds/voids.", path: ["note"] },
);
