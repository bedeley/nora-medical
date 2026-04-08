import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/origin";
import { extractAuditTrace, hashAuditState } from "@/lib/accounting-period-audit";
import { verifyCronSecret } from "@/lib/cron-auth";

function isAuthorizedUser(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function isAuthorizedCron(req: Request) {
  return verifyCronSecret(req, "ACCOUNTING_PERIODS_AUTOGEN_CRON_SECRET");
}

type InitializedYearRow = {
  year: number;
  initializedAt: string;
  initializedById?: string | null;
  initializedByName?: string | null;
};

function getMonthsAhead() {
  const raw = Number(process.env.ACCOUNTING_PERIODS_AUTOGEN_MONTHS_AHEAD || 12);
  if (!Number.isFinite(raw)) return 12;
  return Math.min(36, Math.max(1, Math.trunc(raw)));
}

function parseInitializedYears(value: unknown): InitializedYearRow[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const rows: InitializedYearRow[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const year = Number((row as { year?: unknown }).year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100 || seen.has(year)) continue;
    seen.add(year);
    rows.push({
      year,
      initializedAt: String((row as { initializedAt?: unknown }).initializedAt || new Date().toISOString()),
      initializedById: (row as { initializedById?: unknown }).initializedById
        ? String((row as { initializedById?: unknown }).initializedById)
        : null,
      initializedByName: (row as { initializedByName?: unknown }).initializedByName
        ? String((row as { initializedByName?: unknown }).initializedByName)
        : null,
    });
  }
  rows.sort((a, b) => b.year - a.year);
  return rows;
}

async function loadInitializedYears() {
  const setting = await prisma.appSetting.findUnique({
    where: { key: "accounting.monthlyClose.initializedYears" },
    select: { value: true },
  });
  return parseInitializedYears(setting?.value ?? null);
}

async function saveInitializedYears(rows: InitializedYearRow[]) {
  const normalized = parseInitializedYears(rows);
  await prisma.appSetting.upsert({
    where: { key: "accounting.monthlyClose.initializedYears" },
    update: { value: normalized },
    create: { key: "accounting.monthlyClose.initializedYears", value: normalized },
  });
  return normalized;
}

async function runAutoGenerate(params: {
  actorId?: string | null;
  trigger: "cron" | "manual";
  trace: ReturnType<typeof extractAuditTrace>;
}) {
  const monthsAhead = getMonthsAhead();
  const now = new Date();
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const startYear = windowStart.getUTCFullYear();
  const endYear = new Date(
    Date.UTC(windowStart.getUTCFullYear(), windowStart.getUTCMonth() + monthsAhead - 1, 1, 0, 0, 0, 0),
  ).getUTCFullYear();
  const targetYears = Array.from({ length: endYear - startYear + 1 }, (_, idx) => startYear + idx);
  const existing = await loadInitializedYears();
  const beforeState = existing.map((row) => ({ year: row.year, initializedAt: row.initializedAt }));
  const existingSet = new Set(existing.map((row) => row.year));
  const created: number[] = [];
  const skipped: number[] = [];

  let rows = existing;
  for (const year of targetYears) {
    if (existingSet.has(year)) {
      skipped.push(year);
      continue;
    }
    rows = [
      ...rows,
      {
        year,
        initializedAt: new Date().toISOString(),
        initializedById: params.actorId || null,
        initializedByName: params.trigger === "cron" ? "System cron" : "Manual run",
      },
    ];
    created.push(year);
    existingSet.add(year);
  }
  const saved = await saveInitializedYears(rows);
  const afterState = saved.map((row) => ({ year: row.year, initializedAt: row.initializedAt }));

  await recordAuditLog({
    actorId: params.actorId || null,
    action:
      params.trigger === "cron"
        ? "fiscal-period.auto_generate.cron.run"
        : "fiscal-period.auto_generate.manual.run",
    entityType: "FiscalPeriodBatch",
    entityId: `${windowStart.toISOString().slice(0, 7)}:${monthsAhead}`,
    meta: {
      reasonCode: params.trigger === "cron" ? "CRON_AUTO_INIT_WINDOW" : "MANUAL_AUTO_INIT_WINDOW",
      traceId: params.trace.traceId,
      requestId: params.trace.requestId,
      correlationId: params.trace.correlationId,
      requestPath: params.trace.requestPath,
      requestMethod: params.trace.requestMethod,
      beforeHash: hashAuditState(beforeState),
      afterHash: hashAuditState(afterState),
      trigger: params.trigger,
      monthsAhead,
      targetYears,
      created,
      skipped,
      createdYearsCount: created.length,
      skippedYearsCount: skipped.length,
      initializedYearsCount: saved.length,
    },
  });

  return {
    ok: true,
    trigger: params.trigger,
    windowStart: windowStart.toISOString().slice(0, 10),
    monthsAhead,
    targetYears,
    created,
    skipped,
    initializedYears: saved,
  };
}

export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runAutoGenerate({ trigger: "cron", actorId: null, trace: extractAuditTrace(req) });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Fiscal period auto-generate cron error:", error);
    return NextResponse.json({ error: "Failed to auto-generate fiscal periods." }, { status: 500 });
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
    const result = await runAutoGenerate({
      trigger: "manual",
      actorId: (session.user as AuthenticatedUser).id,
      trace: extractAuditTrace(req),
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Fiscal period auto-generate manual error:", error);
    return NextResponse.json({ error: "Failed to auto-generate fiscal periods." }, { status: 500 });
  }
}
