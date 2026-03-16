import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";
import { extractAuditTrace, hashAuditState } from "@/lib/accounting-period-audit";
import {
  isValidMonthKey,
  loadMonthlyCloseRows,
  parseMonthlyCloseRows,
  saveMonthlyCloseRows,
  type MonthlyCloseRow,
} from "@/lib/accounting-periods";

const actionSchema = z.object({
  month: z.string().min(7).max(7),
  action: z.enum(["close", "open"]),
  force: z.boolean().optional(),
  note: z.string().max(500).optional(),
  overrideReason: z.string().max(500).optional(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function parseReopenWindowDays(value: unknown, fallback: number) {
  const next = Number(typeof value === "number" ? value : Number(value));
  if (!Number.isFinite(next)) return fallback;
  return Math.min(365, Math.max(0, Math.trunc(next)));
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await loadMonthlyCloseRows();
  return NextResponse.json({ rows });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-accounting-monthly-close", 60_000, 120);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const month = String(parsed.data.month || "").trim();
  if (!isValidMonthKey(month)) {
    return NextResponse.json({ error: "Month must be YYYY-MM." }, { status: 400 });
  }
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const monthStart = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
  const monthEnd = new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999));
  const now = new Date();

  const [draftEntries, openReconciliations] = await Promise.all([
    prisma.journalEntry.count({
      where: {
        status: "DRAFT",
        entryDate: {
          gte: monthStart,
          lte: monthEnd,
        },
      },
    }),
    prisma.reconciliation.count({
      where: {
        status: { not: "CLOSED" },
        periodStart: { lte: monthEnd },
        periodEnd: { gte: monthStart },
      },
    }),
  ]);
  const blockers = {
    draftEntries,
    openReconciliations,
  };

  const existing = await loadMonthlyCloseRows();
  const trace = extractAuditTrace(req);
  const beforeRow = existing.find((row) => row.month === month) || null;
  let next: MonthlyCloseRow[] = existing;

  if (parsed.data.action === "close") {
    const isEarlyClose = monthEnd.getTime() > now.getTime();
    const overrideReason = (parsed.data.overrideReason || "").trim();
    if (isEarlyClose) {
      if (user?.role !== "ADMIN") {
        return NextResponse.json(
          { error: "Early monthly close is restricted to admin override." },
          { status: 403 },
        );
      }
      if (!parsed.data.force) {
        return NextResponse.json(
          { error: "Cannot close month before month-end without explicit force override.", blockers },
          { status: 400 },
        );
      }
      if (overrideReason.length < 20) {
        return NextResponse.json(
          { error: "Early monthly close requires an override reason of at least 20 characters.", blockers },
          { status: 400 },
        );
      }
    }
    if ((draftEntries > 0 || openReconciliations > 0) && !parsed.data.force) {
      return NextResponse.json(
        {
          error: "Monthly close has blockers. Resolve blockers or use force with override reason.",
          blockers,
        },
        { status: 400 },
      );
    }
    if ((draftEntries > 0 || openReconciliations > 0) && !overrideReason) {
      return NextResponse.json(
        { error: "Override reason is required when forcing monthly close with blockers.", blockers },
        { status: 400 },
      );
    }
    if (!existing.some((row) => row.month === month)) {
      next = parseMonthlyCloseRows([
        ...existing,
        {
          month,
          closedAt: new Date().toISOString(),
          closedById: user?.id || null,
          closedByName: user?.name || user?.email || null,
          note: parsed.data.note?.trim() || overrideReason || null,
        },
      ]);
    }
  } else {
    const reason = String(parsed.data.note || "").trim();
    if (reason.length < 8) {
      return NextResponse.json(
        { error: "Reopen requires a reason of at least 8 characters." },
        { status: 400 },
      );
    }
    const monthlyWindowSetting = await prisma.appSetting.findUnique({
      where: { key: "accounting.reopen.monthlyWindowDays" },
      select: { value: true },
    });
    const monthlyWindowDays = parseReopenWindowDays(monthlyWindowSetting?.value, 7);
    const reopenDeadline = new Date(monthEnd.getTime() + monthlyWindowDays * 86_400_000);
    if (now.getTime() > reopenDeadline.getTime()) {
      return NextResponse.json(
        { error: `Reopen window expired. Monthly close can be reopened only within ${monthlyWindowDays} day(s) after month-end.` },
        { status: 400 },
      );
    }
    next = existing.filter((row) => row.month !== month);
  }

  const saved = await saveMonthlyCloseRows(next);
  const afterRow = saved.find((row) => row.month === month) || null;
  const reasonCode =
    parsed.data.action === "close"
      ? Boolean(parsed.data.force)
        ? monthEnd.getTime() > now.getTime()
          ? "EARLY_CLOSE_OVERRIDE"
          : "FORCE_CLOSE_WITH_BLOCKERS"
        : "STANDARD_CLOSE"
      : "MANUAL_REOPEN_WITHIN_WINDOW";

  await recordAuditLog({
    actorId: user?.id || null,
    action: parsed.data.action === "close" ? "fiscal-month.close" : "fiscal-month.open",
    entityType: "FiscalMonth",
    entityId: month,
    meta: {
      reasonCode,
      traceId: trace.traceId,
      requestId: trace.requestId,
      correlationId: trace.correlationId,
      requestPath: trace.requestPath,
      requestMethod: trace.requestMethod,
      beforeStatus: beforeRow ? "CLOSED" : "OPEN",
      afterStatus: afterRow ? "CLOSED" : "OPEN",
      beforeHash: hashAuditState(beforeRow || { month, status: "OPEN" }),
      afterHash: hashAuditState(afterRow || { month, status: "OPEN" }),
      month,
      action: parsed.data.action,
      note: parsed.data.note?.trim() || null,
      overrideReason: parsed.data.overrideReason?.trim() || null,
      force: Boolean(parsed.data.force),
      earlyClose: parsed.data.action === "close" ? monthEnd.getTime() > now.getTime() : false,
      blockers,
      actorRole: user?.role || null,
      closedCount: saved.length,
    },
  });

  return NextResponse.json({ rows: saved, blockers });
}
