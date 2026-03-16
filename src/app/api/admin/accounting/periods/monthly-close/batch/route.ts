import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";
import { isValidMonthKey, loadMonthlyCloseRows, parseMonthlyCloseRows, saveMonthlyCloseRows } from "@/lib/accounting-periods";
import { extractAuditTrace, hashAuditState } from "@/lib/accounting-period-audit";

const batchSchema = z.object({
  months: z.array(z.string().min(7).max(7)).min(1).max(24),
  action: z.enum(["close", "open"]),
  note: z.string().max(500).optional(),
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

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-accounting-monthly-close-batch", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const parsed = batchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const months = Array.from(new Set(parsed.data.months.map((m) => String(m || "").trim())));
  if (months.some((m) => !isValidMonthKey(m))) {
    return NextResponse.json({ error: "All months must be YYYY-MM." }, { status: 400 });
  }
  if (parsed.data.action === "open" && String(parsed.data.note || "").trim().length < 8) {
    return NextResponse.json({ error: "Batch reopen requires a reason of at least 8 characters." }, { status: 400 });
  }
  if (parsed.data.action === "open") {
    const monthlyWindowSetting = await prisma.appSetting.findUnique({
      where: { key: "accounting.reopen.monthlyWindowDays" },
      select: { value: true },
    });
    const monthlyWindowDays = parseReopenWindowDays(monthlyWindowSetting?.value, 7);
    const now = new Date();
    const expiredMonths = months
      .map((month) => {
        const [yearText, monthText] = month.split("-");
        const year = Number(yearText);
        const monthIndex = Number(monthText) - 1;
        const monthEnd = new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999));
        const reopenDeadline = new Date(monthEnd.getTime() + monthlyWindowDays * 86_400_000);
        return { month, expired: now.getTime() > reopenDeadline.getTime() };
      })
      .filter((row) => row.expired)
      .map((row) => row.month);
    if (expiredMonths.length > 0) {
      return NextResponse.json(
        {
          error: `Batch reopen blocked. Reopen window is ${monthlyWindowDays} day(s) after month-end.`,
          expiredMonths,
        },
        { status: 400 },
      );
    }
  }

  if (parsed.data.action === "close") {
    const now = new Date();
    const earlyMonths = months
      .map((month) => {
        const [yearText, monthText] = month.split("-");
        const year = Number(yearText);
        const monthIndex = Number(monthText) - 1;
        const monthEnd = new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999));
        return { month, isEarly: monthEnd.getTime() > now.getTime() };
      })
      .filter((row) => row.isEarly)
      .map((row) => row.month);
    if (earlyMonths.length > 0) {
      return NextResponse.json(
        {
          error: "Batch close does not allow early month close. Use single-month close with admin override after review.",
          earlyMonths,
        },
        { status: 400 },
      );
    }

    const blockerRows = await Promise.all(
      months.map(async (month) => {
        const [yearText, monthText] = month.split("-");
        const year = Number(yearText);
        const monthIndex = Number(monthText) - 1;
        const monthStart = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
        const monthEnd = new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999));
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
        return {
          month,
          draftEntries,
          openReconciliations,
          blockers: draftEntries + openReconciliations,
        };
      }),
    );
    const blockingMonths = blockerRows.filter((row) => row.blockers > 0);
    if (blockingMonths.length > 0) {
      return NextResponse.json(
        {
          error: "Batch close blocked. Resolve blockers in listed months first.",
          blockers: blockingMonths,
        },
        { status: 400 },
      );
    }
  }

  const existing = await loadMonthlyCloseRows();
  const trace = extractAuditTrace(req);
  const beforeClosedSet = new Set(existing.map((row) => row.month));
  const beforeStatuses = Object.fromEntries(months.map((month) => [month, beforeClosedSet.has(month) ? "CLOSED" : "OPEN"]));
  const existingMap = new Map(existing.map((r) => [r.month, r]));
  let next = [...existing];
  const affected: string[] = [];

  if (parsed.data.action === "close") {
    for (const month of months) {
      if (existingMap.has(month)) continue;
      next.push({
        month,
        closedAt: new Date().toISOString(),
        closedById: user?.id || null,
        closedByName: user?.name || user?.email || null,
        note: parsed.data.note?.trim() || null,
      });
      affected.push(month);
    }
  } else {
    next = next.filter((row) => {
      const remove = months.includes(row.month);
      if (remove) affected.push(row.month);
      return !remove;
    });
  }

  const saved = await saveMonthlyCloseRows(parseMonthlyCloseRows(next));
  const afterClosedSet = new Set(saved.map((row) => row.month));
  const afterStatuses = Object.fromEntries(months.map((month) => [month, afterClosedSet.has(month) ? "CLOSED" : "OPEN"]));
  const reasonCode = parsed.data.action === "close" ? "BATCH_STANDARD_CLOSE" : "BATCH_MANUAL_REOPEN_WITHIN_WINDOW";
  await recordAuditLog({
    actorId: user?.id || null,
    action: parsed.data.action === "close" ? "fiscal-month.batch.close" : "fiscal-month.batch.open",
    entityType: "FiscalMonth",
    entityId: `batch:${affected.length}`,
    meta: {
      reasonCode,
      traceId: trace.traceId,
      requestId: trace.requestId,
      correlationId: trace.correlationId,
      requestPath: trace.requestPath,
      requestMethod: trace.requestMethod,
      beforeHash: hashAuditState(beforeStatuses),
      afterHash: hashAuditState(afterStatuses),
      months: affected,
      count: affected.length,
      note: parsed.data.note?.trim() || null,
      actorRole: user?.role || null,
      closedCount: saved.length,
    },
  });

  return NextResponse.json({ ok: true, affected, rows: saved });
}
