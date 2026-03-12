import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";

const matchSchema = z.object({
  bankTransactionId: z.string().min(1),
  journalLineId: z.string().optional().nullable(),
  matchStatus: z.enum(["UNMATCHED", "MATCHED", "PARTIAL"]).optional(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

const getReconciliationId = (req: Request) => {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  return parts[parts.length - 2] || "";
};

export async function POST(req: Request) {
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
    const body = await req.json();
    const parsed = matchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    if (parsed.data.journalLineId) {
      const existingLine = await prisma.reconciliationLine.findFirst({
        where: { journalLineId: parsed.data.journalLineId },
        select: { id: true, bankTransactionId: true },
      });
      if (existingLine && existingLine.bankTransactionId !== parsed.data.bankTransactionId) {
        await prisma.bankTransaction.update({
          where: { id: existingLine.bankTransactionId },
          data: { matched: false },
        });
        await prisma.reconciliationLine.delete({
          where: { id: existingLine.id },
        });
      }
    }
    const reconciliation = await prisma.reconciliation.findUnique({
      where: { id: recId },
      select: { status: true },
    });
    if (!reconciliation) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (reconciliation.status === "CLOSED") {
      return NextResponse.json({ error: "Reconciliation is closed" }, { status: 400 });
    }
    const matchStatus = parsed.data.matchStatus ?? (parsed.data.journalLineId ? "MATCHED" : "UNMATCHED");
    const line = await prisma.reconciliationLine.upsert({
      where: { bankTransactionId: parsed.data.bankTransactionId },
      update: {
        reconciliationId: recId,
        journalLineId: parsed.data.journalLineId ?? null,
        matchStatus,
      },
      create: {
        reconciliationId: recId,
        bankTransactionId: parsed.data.bankTransactionId,
        journalLineId: parsed.data.journalLineId ?? null,
        matchStatus,
      },
    });
    await prisma.bankTransaction.update({
      where: { id: parsed.data.bankTransactionId },
      data: { matched: matchStatus === "MATCHED" },
    });
    await recordAuditLog({
      actorId: (session.user as AuthenticatedUser).id,
      action: "reconciliation.match",
      entityType: "Reconciliation",
      entityId: recId,
      meta: {
        bankTransactionId: parsed.data.bankTransactionId,
        journalLineId: parsed.data.journalLineId ?? null,
        matchStatus,
      },
    });
    return NextResponse.json(line);
  } catch (error) {
    console.error("Accounting reconciliation match error:", error);
    return NextResponse.json({ error: "Failed to match transaction" }, { status: 500 });
  }
}
