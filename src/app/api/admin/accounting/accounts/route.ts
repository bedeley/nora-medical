import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";

const SYSTEM_ACCOUNT_CODES = new Set([
  "1000", // Cash
  "1010", // Bank
  "1020", // Cash in transit
  "1100", // AR
  "1200", // Inventory
  "2000", // AP
  "2100", // VAT payable
  "2200", // Store credit
  "3000", // Owner equity
  "4000", // Sales revenue
  "5000", // COGS
  "6000", // Operating expenses
  "6100", // Payroll expense
  "6990", // Cash over/short
]);

const accountSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(2).max(120),
  type: z.enum(["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]),
  subtype: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
  parentAccountId: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
});

const updateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(2).max(120).optional(),
  subtype: z.string().max(120).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  parentAccountId: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

const DEFAULT_MANUAL_EXPENSE_ACCOUNTS: Array<{ code: string; name: string }> = [
  { code: "6000", name: "Operating Expenses" },
  { code: "6200", name: "Delivery & Logistics Expense" },
  { code: "6300", name: "Bank Charges & Fees" },
  { code: "6400", name: "Utilities Expense" },
  { code: "6500", name: "Rent Expense" },
  { code: "6600", name: "Repairs & Maintenance" },
  { code: "6700", name: "Marketing Expense" },
  { code: "6800", name: "Professional Fees" },
  { code: "6810", name: "Insurance Expense" },
  { code: "6820", name: "Licenses & Regulatory Fees" },
  { code: "6830", name: "Office Supplies Expense" },
  { code: "6840", name: "Communication & Internet Expense" },
];

async function ensureDefaultManualExpenseAccounts() {
  const existing = await prisma.ledgerAccount.findMany({
    where: { code: { in: DEFAULT_MANUAL_EXPENSE_ACCOUNTS.map((a) => a.code) } },
    select: { code: true },
  });
  const existingCodes = new Set(existing.map((row) => row.code));
  const missing = DEFAULT_MANUAL_EXPENSE_ACCOUNTS.filter((row) => !existingCodes.has(row.code));
  if (!missing.length) return;
  await prisma.ledgerAccount.createMany({
    data: missing.map((row) => ({
      code: row.code,
      name: row.name,
      type: "EXPENSE",
      isActive: true,
    })),
    skipDuplicates: true,
  });
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureDefaultManualExpenseAccounts();

  const accounts = await prisma.ledgerAccount.findMany({
    orderBy: [{ code: "asc" }],
  });
  return NextResponse.json(accounts);
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const parsed = accountSchema.safeParse({
      ...body,
      parentAccountId: body.parentAccountId || null,
      isActive: body.isActive ?? true,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const account = await prisma.ledgerAccount.create({
      data: parsed.data,
    });
    return NextResponse.json(account);
  } catch (error) {
    console.error("Accounting accounts create error:", error);
    return NextResponse.json({ error: "Failed to create account" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const parsed = updateSchema.safeParse({
      ...body,
      parentAccountId: body.parentAccountId || null,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const existing = await prisma.ledgerAccount.findUnique({ where: { id: parsed.data.id } });
    if (!existing) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    if (SYSTEM_ACCOUNT_CODES.has(existing.code)) {
      return NextResponse.json(
        { error: "System accounts are protected and cannot be edited/archived." },
        { status: 403 },
      );
    }

    if (parsed.data.parentAccountId && parsed.data.parentAccountId === parsed.data.id) {
      return NextResponse.json({ error: "Account cannot be its own parent." }, { status: 400 });
    }

    const account = await prisma.ledgerAccount.update({
      where: { id: parsed.data.id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.subtype !== undefined
          ? { subtype: parsed.data.subtype || null }
          : {}),
        ...(parsed.data.description !== undefined
          ? { description: parsed.data.description || null }
          : {}),
        ...(parsed.data.parentAccountId !== undefined
          ? { parentAccountId: parsed.data.parentAccountId || null }
          : {}),
        ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
      },
    });

    return NextResponse.json(account);
  } catch (error) {
    console.error("Accounting accounts patch error:", error);
    return NextResponse.json({ error: "Failed to update account" }, { status: 500 });
  }
}
