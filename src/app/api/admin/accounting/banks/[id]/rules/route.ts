import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";

const ruleSchema = z.object({
  name: z.string().min(1).max(120),
  matchText: z.string().min(1).max(200),
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

const getBankId = (req: Request) => {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  return parts[parts.length - 2] || "";
};

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const bankId = getBankId(req);
  if (!bankId) {
    return NextResponse.json({ error: "Missing bank id" }, { status: 400 });
  }

  const rules = await prisma.bankMatchRule.findMany({
    where: { bankAccountId: bankId },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    include: { account: true },
  });
  return NextResponse.json(rules);
}

export async function POST(
  req: Request,
) {
  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const bankId = getBankId(req);
  if (!bankId) {
    return NextResponse.json({ error: "Missing bank id" }, { status: 400 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const parsed = ruleSchema.safeParse({
      ...body,
      minAmount: body.minAmount === "" ? null : body.minAmount,
      maxAmount: body.maxAmount === "" ? null : body.maxAmount,
      amountTolerance: body.amountTolerance === "" ? null : body.amountTolerance,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const rule = await prisma.bankMatchRule.create({
      data: {
        bankAccountId: bankId,
        name: parsed.data.name,
        matchText: parsed.data.matchText,
        matchMode: parsed.data.matchMode ?? "CONTAINS",
        accountId: parsed.data.accountId ?? null,
        minAmount: parsed.data.minAmount ?? null,
        maxAmount: parsed.data.maxAmount ?? null,
        amountTolerance: parsed.data.amountTolerance ?? 0,
        priority: parsed.data.priority ?? 0,
        isActive: parsed.data.isActive ?? true,
      },
      include: { account: true },
    });
    await prisma.auditLog.create({
      data: {
        actorId: actor?.id || null,
        action: "BANK_RULE_CREATED",
        entityType: "BANK_MATCH_RULE",
        entityId: rule.id,
        meta: JSON.stringify({
          bankAccountId: bankId,
          name: rule.name,
          matchMode: rule.matchMode,
          matchText: rule.matchText,
          accountId: rule.accountId ?? null,
          minAmount: rule.minAmount ?? null,
          maxAmount: rule.maxAmount ?? null,
          amountTolerance: rule.amountTolerance ?? 0,
          priority: rule.priority ?? 0,
          isActive: rule.isActive,
        }),
      },
    });

    return NextResponse.json(rule);
  } catch (error) {
    console.error("Accounting bank match rule create error:", error);
    return NextResponse.json({ error: "Failed to create match rule" }, { status: 500 });
  }
}
