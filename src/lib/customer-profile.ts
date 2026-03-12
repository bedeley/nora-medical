import { prisma } from "@/lib/prisma";

export type CustomerProfileType = "B2B" | "B2C";

const CUSTOMER_PROFILE_KEY = "customer.profile.type";
const DEFAULT_CUSTOMER_PROFILE: CustomerProfileType = "B2B";

function normalizeProfile(value: unknown): CustomerProfileType | null {
  if (typeof value === "string") {
    const up = value.trim().toUpperCase();
    if (up === "B2B" || up === "B2C") return up;
  }
  if (value && typeof value === "object") {
    const maybe = (value as { type?: unknown }).type;
    if (typeof maybe === "string") {
      const up = maybe.trim().toUpperCase();
      if (up === "B2B" || up === "B2C") return up;
    }
  }
  return null;
}

export async function getCustomerProfileType(userId: string): Promise<CustomerProfileType> {
  const pref = await prisma.userPreference.findUnique({
    where: { userId_key: { userId, key: CUSTOMER_PROFILE_KEY } },
    select: { value: true },
  });
  const parsed = normalizeProfile(pref?.value);
  return parsed || DEFAULT_CUSTOMER_PROFILE;
}

export async function setCustomerProfileType(userId: string, type: CustomerProfileType) {
  return prisma.userPreference.upsert({
    where: { userId_key: { userId, key: CUSTOMER_PROFILE_KEY } },
    update: { value: type },
    create: { userId, key: CUSTOMER_PROFILE_KEY, value: type },
  });
}

export async function isCustomerB2B(userId: string): Promise<boolean> {
  const profile = await getCustomerProfileType(userId);
  return profile === "B2B";
}

