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

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; ruleId: string }> },
) {
  const resolvedParams = await params;
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
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
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Accounting bank match rule delete error:", error);
    return NextResponse.json({ error: "Failed to delete match rule" }, { status: 500 });
  }
}
