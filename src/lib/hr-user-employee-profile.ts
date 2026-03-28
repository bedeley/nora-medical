import type { Prisma, PrismaClient } from "@prisma/client";

type EmployeeProfileDb = PrismaClient | Prisma.TransactionClient;

export type EmployeeProfileMatchSource = "email" | "phone" | "email_and_phone" | "none";

export type EnsureEmployeeProfileResult = {
  employeeId: string;
  outcome: "existing" | "linked" | "created";
  matchedBy: EmployeeProfileMatchSource;
};

export type EnsureEmployeeProfileInput = {
  userId: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  status?: "ACTIVE" | "ON_LEAVE" | "SUSPENDED" | "TERMINATED";
};

export function splitEmployeeName(fullName: string) {
  const cleaned = String(fullName || "").trim();
  if (!cleaned) return { firstName: "Employee", lastName: "User" };
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { firstName: parts[0], lastName: "Employee" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export function detectEmployeeProfileMatchSource(input: {
  matchedEmail?: string | null;
  matchedPhone?: string | null;
  email?: string | null;
  phone?: string | null;
}): EmployeeProfileMatchSource {
  const email = String(input.email || "").trim().toLowerCase();
  const phone = String(input.phone || "").trim();
  const matchedEmail = String(input.matchedEmail || "").trim().toLowerCase();
  const matchedPhone = String(input.matchedPhone || "").trim();
  const emailMatched = Boolean(email && matchedEmail && email === matchedEmail);
  const phoneMatched = Boolean(phone && matchedPhone && phone === matchedPhone);
  if (emailMatched && phoneMatched) return "email_and_phone";
  if (emailMatched) return "email";
  if (phoneMatched) return "phone";
  return "none";
}

export async function ensureEmployeeProfileForUser(
  db: EmployeeProfileDb,
  input: EnsureEmployeeProfileInput,
): Promise<EnsureEmployeeProfileResult> {
  const userId = String(input.userId || "").trim();
  if (!userId) {
    throw new Error("User id is required.");
  }

  const normalizedEmail = String(input.email || "").trim().toLowerCase() || null;
  const normalizedPhone = String(input.phone || "").trim() || null;

  const existingLinked = await db.employee.findFirst({
    where: { userId },
    select: { id: true },
  });
  if (existingLinked) {
    return {
      employeeId: existingLinked.id,
      outcome: "existing",
      matchedBy: "none",
    };
  }

  const matchFilters = [
    normalizedEmail ? { email: normalizedEmail } : null,
    normalizedPhone ? { phone: normalizedPhone } : null,
  ].filter(Boolean) as Array<{ email?: string; phone?: string }>;

  if (matchFilters.length) {
    const existingEmployee = await db.employee.findFirst({
      where: { OR: matchFilters },
      select: {
        id: true,
        userId: true,
        email: true,
        phone: true,
      },
    });

    if (existingEmployee) {
      if (existingEmployee.userId && existingEmployee.userId !== userId) {
        throw new Error("A matching HR employee profile is already linked to another user.");
      }

      await db.employee.update({
        where: { id: existingEmployee.id },
        data: {
          userId,
          ...(normalizedEmail && !existingEmployee.email ? { email: normalizedEmail } : {}),
          ...(normalizedPhone && !existingEmployee.phone ? { phone: normalizedPhone } : {}),
        },
      });

      return {
        employeeId: existingEmployee.id,
        outcome: "linked",
        matchedBy: detectEmployeeProfileMatchSource({
          matchedEmail: existingEmployee.email,
          matchedPhone: existingEmployee.phone,
          email: normalizedEmail,
          phone: normalizedPhone,
        }),
      };
    }
  }

  const nameParts = splitEmployeeName(input.name || "");
  const created = await db.employee.create({
    data: {
      firstName: nameParts.firstName,
      lastName: nameParts.lastName,
      email: normalizedEmail,
      phone: normalizedPhone,
      userId,
      status: input.status || "ACTIVE",
    },
    select: { id: true },
  });

  return {
    employeeId: created.id,
    outcome: "created",
    matchedBy: "none",
  };
}
