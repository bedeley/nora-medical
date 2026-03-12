import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { z } from "zod";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

const getReconciliationId = (req: Request) => {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
};

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const recId = getReconciliationId(req);
  if (!recId) {
    return NextResponse.json({ error: "Missing reconciliation id" }, { status: 400 });
  }
  const rec = await prisma.reconciliation.findUnique({
    where: { id: recId },
    include: {
      bankAccount: true,
      assignedTo: { select: { id: true, name: true, email: true } },
      lines: { include: { bankTransaction: true, journalLine: true } },
    },
  });
  if (!rec) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(rec);
}

export async function PATCH(
  req: Request,
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const recId = getReconciliationId(req);
  if (!recId) {
    return NextResponse.json({ error: "Missing reconciliation id" }, { status: 400 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const assignPayload = z
      .object({
        assignedToId: z.string().nullable().optional(),
      })
      .safeParse(body);
    if (assignPayload.success && Object.prototype.hasOwnProperty.call(assignPayload.data, "assignedToId")) {
      const assignedToId = assignPayload.data.assignedToId || null;
      if (assignedToId) {
        const assignee = await prisma.user.findUnique({
          where: { id: assignedToId },
          select: { id: true, role: true, name: true, email: true },
        });
        if (!assignee || (assignee.role !== "ADMIN" && assignee.role !== "ACCOUNTANT")) {
          return NextResponse.json({ error: "Invalid assignee" }, { status: 400 });
        }
      }
      const rec = await prisma.reconciliation.update({
        where: { id: recId },
        data: { assignedToId },
        include: { assignedTo: { select: { id: true, name: true, email: true } } },
      });
      await recordAuditLog({
        actorId: (session.user as AuthenticatedUser).id,
        action: assignedToId ? "reconciliation.assign" : "reconciliation.unassign",
        entityType: "Reconciliation",
        entityId: recId,
        meta: { assignedToId },
      });
      return NextResponse.json(rec);
    }

    const force = Boolean(body?.force);
    const existing = await prisma.reconciliation.findUnique({
      where: { id: recId },
      select: {
        id: true,
        bankAccountId: true,
        periodStart: true,
        periodEnd: true,
        status: true,
        bankAccount: { select: { name: true } },
      },
    });
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (existing.status === "CLOSED") {
      return NextResponse.json(existing);
    }
    const [unmatchedBankTxns, unmatchedJournalLines] = await Promise.all([
      prisma.bankTransaction.count({
        where: {
          bankAccountId: existing.bankAccountId,
          postedAt: {
            gte: existing.periodStart,
            lte: existing.periodEnd,
          },
          matched: false,
        },
      }),
      prisma.journalLine.count({
        where: {
          reconciliationLine: null,
          account: {
            OR: [
              { code: "1010" },
              existing.bankAccount?.name
                ? { name: { contains: existing.bankAccount.name, mode: "insensitive" } }
                : undefined,
              { name: { contains: "bank", mode: "insensitive" } },
            ].filter(Boolean) as Array<Record<string, unknown>>,
          },
          entry: {
            status: "POSTED",
            entryDate: {
              gte: existing.periodStart,
              lte: existing.periodEnd,
            },
          },
        },
      }),
    ]);
    if (!force && (unmatchedBankTxns > 0 || unmatchedJournalLines > 0)) {
      return NextResponse.json(
        {
          error: "Unmatched items remain.",
          unmatchedBankTxns,
          unmatchedJournalLines,
        },
        { status: 400 },
      );
    }
    const rec = await prisma.reconciliation.update({
      where: { id: recId },
      data: { status: "CLOSED" },
    });
    await recordAuditLog({
      actorId: (session.user as AuthenticatedUser).id,
      action: "reconciliation.close",
      entityType: "Reconciliation",
      entityId: recId,
    });
    return NextResponse.json(rec);
  } catch (error) {
    console.error("Accounting reconciliation close error:", error);
    return NextResponse.json({ error: "Failed to close reconciliation" }, { status: 500 });
  }
}
