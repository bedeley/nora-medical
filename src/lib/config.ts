const DEFAULT_ADMIN_PHONE = "(555) 275 3826";
export const ADMIN_PHONE = process.env.NEXT_PUBLIC_ADMIN_PHONE || DEFAULT_ADMIN_PHONE;
export const ADMIN_PHONE_TEL = `tel:${ADMIN_PHONE.replace(/[^\d+]/g, "")}`;

const PHONE_FLAG_VALUE =
  (process.env.NEXT_PUBLIC_PHONE_VERIFICATION_ENABLED ||
    process.env.PHONE_VERIFICATION_ENABLED ||
    "").toLowerCase();

export const PHONE_VERIFICATION_ENABLED =
  PHONE_FLAG_VALUE === "1" ||
  PHONE_FLAG_VALUE === "true" ||
  PHONE_FLAG_VALUE === "yes";
