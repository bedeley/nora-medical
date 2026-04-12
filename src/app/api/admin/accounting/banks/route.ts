import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAccountingBankAudit } from "@/lib/accounting-bank-audit";

const bankSchema = z.object({
  name: z.string().min(2).max(120),
  bankName: z.string().max(120).optional(),
  accountNumberMasked: z.string().max(30).optional(),
  currency: z.string().max(8).optional(),
  isActive: z.boolean().optional(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const banks = await prisma.bankAccount.findMany({
    orderBy: [{ name: "asc" }],
  });
  return NextResponse.json(banks);
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
    const parsed = bankSchema.safeParse({
      ...body,
      currency: body.currency || "GHS",
      isActive: body.isActive ?? true,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const bank = await prisma.bankAccount.create({ data: parsed.data });
    const actor = session.user as AuthenticatedUser;
    await recordAccountingBankAudit({
      req,
      actor,
      action: "BANK_ACCOUNT_CREATED",
      entityType: "BANK_ACCOUNT",
      entityId: bank.id,
      section: "bank-profile",
      operation: "create",
      resultSummary: `Created bank account ${bank.name}.`,
      meta: {
        name: bank.name,
        bankName: bank.bankName || null,
        accountNumberMasked: bank.accountNumberMasked || null,
        currency: bank.currency,
        isActive: bank.isActive,
      },
    });
    return NextResponse.json(bank);
  } catch (error) {
    console.error("Accounting bank create error:", error);
    return NextResponse.json({ error: "Failed to create bank" }, { status: 500 });
  }
}
