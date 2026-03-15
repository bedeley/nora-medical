import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";

const updateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  bankName: z.string().max(120).optional().nullable(),
  accountNumberMasked: z.string().max(30).optional().nullable(),
  currency: z.string().max(8).optional(),
  isActive: z.boolean().optional(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  try {
    const body = await req.json();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const before = await prisma.bankAccount.findUnique({ where: { id } });
    if (!before) {
      return NextResponse.json({ error: "Bank account not found" }, { status: 404 });
    }
    const bank = await prisma.bankAccount.update({
      where: { id },
      data: parsed.data,
    });
    const actor = session.user as AuthenticatedUser;
    const actorIdCandidate = String(actor?.id || "").trim();
    let safeActorId: string | null = null;
    if (actorIdCandidate) {
      const actorExists = await prisma.user.findUnique({
        where: { id: actorIdCandidate },
        select: { id: true },
      });
      safeActorId = actorExists?.id || null;
    }
    try {
      await prisma.auditLog.create({
        data: {
          actorId: safeActorId,
          action: "BANK_ACCOUNT_UPDATED",
          entityType: "BANK_ACCOUNT",
          entityId: bank.id,
          meta: JSON.stringify({
            before: {
              name: before.name,
              bankName: before.bankName || null,
              accountNumberMasked: before.accountNumberMasked || null,
              currency: before.currency,
              isActive: before.isActive,
            },
            after: {
              name: bank.name,
              bankName: bank.bankName || null,
              accountNumberMasked: bank.accountNumberMasked || null,
              currency: bank.currency,
              isActive: bank.isActive,
            },
          }),
        },
      });
    } catch (auditError) {
      console.error("Accounting bank update audit error:", auditError);
    }
    return NextResponse.json(bank);
  } catch (error) {
    console.error("Accounting bank update error:", error);
    return NextResponse.json({ error: "Failed to update bank" }, { status: 500 });
  }
}
