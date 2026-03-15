import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  matchText: z.string().min(1).max(200).optional(),
  matchMode: z.enum(["CONTAINS", "STARTS_WITH", "ENDS_WITH", "REGEX"]).optional(),
  accountId: z.string().optional().nullable(),
  minAmount: z.number().optional().nullable(),
  maxAmount: z.number().optional().nullable(),
  amountTolerance: z.number().optional().nullable(),
  priority: z.number().optional().nullable(),
  isActive: z.boolean().optional(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function isAdmin(user?: AuthenticatedUser | null) {
  return user?.role === "ADMIN";
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; ruleId: string }> },
) {
  const resolvedParams = await params;
  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const existing = await prisma.bankMatchRule.findFirst({
      where: { id: resolvedParams.ruleId, bankAccountId: resolvedParams.id },
      include: { account: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const rule = await prisma.bankMatchRule.update({
      where: { id: resolvedParams.ruleId },
      data: {
        ...parsed.data,
        minAmount: parsed.data.minAmount ?? undefined,
        maxAmount: parsed.data.maxAmount ?? undefined,
        amountTolerance: parsed.data.amountTolerance ?? undefined,
        priority: parsed.data.priority ?? undefined,
      },
      include: { account: true },
    });
    await prisma.auditLog.create({
      data: {
        actorId: actor?.id || null,
        action: "BANK_RULE_UPDATED",
        entityType: "BANK_MATCH_RULE",
        entityId: rule.id,
        meta: JSON.stringify({
          bankAccountId: resolvedParams.id,
          before: {
            name: existing.name,
            matchText: existing.matchText,
            matchMode: existing.matchMode,
            accountId: existing.accountId ?? null,
            minAmount: existing.minAmount ?? null,
            maxAmount: existing.maxAmount ?? null,
            amountTolerance: existing.amountTolerance ?? 0,
            priority: existing.priority ?? 0,
            isActive: existing.isActive,
          },
          after: {
            name: rule.name,
            matchText: rule.matchText,
            matchMode: rule.matchMode,
            accountId: rule.accountId ?? null,
            minAmount: rule.minAmount ?? null,
            maxAmount: rule.maxAmount ?? null,
            amountTolerance: rule.amountTolerance ?? 0,
            priority: rule.priority ?? 0,
            isActive: rule.isActive,
          },
        }),
      },
    });

    return NextResponse.json(rule);
  } catch (error) {
    console.error("Accounting bank match rule update error:", error);
    return NextResponse.json({ error: "Failed to update match rule" }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; ruleId: string }> },
) {
  const resolvedParams = await params;
  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAdmin(actor)) {
    return NextResponse.json({ error: "Only ADMIN can delete rules." }, { status: 403 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  try {
    const existing = await prisma.bankMatchRule.findFirst({
      where: { id: resolvedParams.ruleId, bankAccountId: resolvedParams.id },
    });
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    await prisma.bankMatchRule.delete({
      where: { id: resolvedParams.ruleId },
    });
    await prisma.auditLog.create({
      data: {
        actorId: actor?.id || null,
        action: "BANK_RULE_DELETED",
        entityType: "BANK_MATCH_RULE",
        entityId: existing.id,
        meta: JSON.stringify({
          bankAccountId: resolvedParams.id,
          name: existing.name,
          matchText: existing.matchText,
          matchMode: existing.matchMode,
          accountId: existing.accountId ?? null,
          priority: existing.priority ?? 0,
        }),
      },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Accounting bank match rule delete error:", error);
    return NextResponse.json({ error: "Failed to delete match rule" }, { status: 500 });
  }
}
