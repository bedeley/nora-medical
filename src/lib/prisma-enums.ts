// Local copies of Prisma enum values to avoid relying on generated enum exports.
export const PaymentStatus = {
  NORMAL: "NORMAL",
  REFUND: "REFUND",
  VOID: "VOID",
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const RefundDestination = {
  CASH: "CASH",
  CREDIT: "CREDIT",
} as const;
export type RefundDestination = (typeof RefundDestination)[keyof typeof RefundDestination];

export const Role = {
  CUSTOMER: "CUSTOMER",
  ADMIN: "ADMIN",
  STAFF: "STAFF",
  ACCOUNTANT: "ACCOUNTANT",
} as const;
export type Role = (typeof Role)[keyof typeof Role];
