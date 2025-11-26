import { z } from "zod";

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
    password: z.string().min(6),
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
);
