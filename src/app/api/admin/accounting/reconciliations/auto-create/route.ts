import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/origin";
import { verifyCronSecret } from "@/lib/cron-auth";

function isAuthorizedUser(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function isAuthorizedCron(req: Request) {
  return verifyCronSecret(req, "RECONCILIATION_AUTOCREATE_CRON_SECRET");
}

function getPreviousMonthPeriod(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-11
  const prevMonthDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const start = new Date(
    Date.UTC(prevMonthDate.getUTCFullYear(), prevMonthDate.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const end = new Date(
    Date.UTC(prevMonthDate.getUTCFullYear(), prevMonthDate.getUTCMonth() + 1, 0, 23, 59, 59, 999),
  );
  return { start, end };
}

async function runAutoCreate(params: { actorId?: string | null; trigger: "cron" | "manual" }) {
  const { start, end } = getPreviousMonthPeriod();

  const bankAccounts = await prisma.bankAccount.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  let created = 0;
  let existed = 0;
  const createdIds: string[] = [];

  for (const bank of bankAccounts) {
    const existing = await prisma.reconciliation.findFirst({
      where: {
        bankAccountId: bank.id,
        periodStart: start,
        periodEnd: end,
      },
      select: { id: true },
    });
    if (existing) {
      existed += 1;
      continue;
    }

    const rec = await prisma.reconciliation.create({
      data: {
        bankAccountId: bank.id,
        periodStart: start,
        periodEnd: end,
        statementBalance: 0,
        status: "DRAFT",
      },
      select: { id: true },
    });
    created += 1;
    createdIds.push(rec.id);

    await recordAuditLog({
      actorId: params.actorId || null,
      action: "reconciliation.auto_create",
      entityType: "Reconciliation",
      entityId: rec.id,
      meta: {
        trigger: params.trigger,
        autoCreated: true,
        statementBalanceDefaulted: true,
      },
    });
  }

  await recordAuditLog({
    actorId: params.actorId || null,
    action:
      params.trigger === "cron"
        ? "reconciliation.auto_create.cron.run"
        : "reconciliation.auto_create.manual.run",
    entityType: "ReconciliationBatch",
    entityId: `${start.toISOString()}_${end.toISOString()}`,
    meta: {
      trigger: params.trigger,
      created,
      existed,
      bankAccounts: bankAccounts.length,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      createdIds,
    },
  });

  return {
    ok: true,
    trigger: params.trigger,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    bankAccounts: bankAccounts.length,
    created,
    existed,
    createdIds,
  };
}

export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runAutoCreate({ trigger: "cron", actorId: null });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Reconciliation auto-create cron error:", error);
    return NextResponse.json(
      { error: "Failed to run reconciliation auto-create cron." },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorizedUser(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  try {
    const result = await runAutoCreate({
      trigger: "manual",
      actorId: (session.user as AuthenticatedUser).id,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Reconciliation auto-create manual run error:", error);
    return NextResponse.json({ error: "Failed to auto-create reconciliations." }, { status: 500 });
  }
}
