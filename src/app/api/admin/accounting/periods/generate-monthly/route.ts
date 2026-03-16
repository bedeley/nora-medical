import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import { extractAuditTrace, hashAuditState } from "@/lib/accounting-period-audit";

const schema = z.object({
  year: z.number().int().min(2000).max(2100),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

type InitializedYearRow = {
  year: number;
  initializedAt: string;
  initializedById?: string | null;
  initializedByName?: string | null;
};

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

function buildMonthsForYear(year: number) {
  return Array.from({ length: 12 }, (_, idx) => {
    const month = String(idx + 1).padStart(2, "0");
    return `${year}-${month}`;
  });
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const initializedYears = await loadInitializedYears();
  return NextResponse.json({ initializedYears });
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

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid year." }, { status: 400 });
  }

  const year = parsed.data.year;
  const existing = await loadInitializedYears();
  const trace = extractAuditTrace(req);
  const beforeState = existing.map((row) => ({ year: row.year, initializedAt: row.initializedAt }));
  const alreadyInitialized = existing.some((row) => row.year === year);
  let saved = existing;
  if (!alreadyInitialized) {
    saved = await saveInitializedYears([
      ...existing,
      {
        year,
        initializedAt: new Date().toISOString(),
        initializedById: user?.id || null,
        initializedByName: user?.name || user?.email || null,
      },
    ]);
  }
  const months = buildMonthsForYear(year);
  const afterState = saved.map((row) => ({ year: row.year, initializedAt: row.initializedAt }));

  await recordAuditLog({
    actorId: user?.id || null,
    action: "fiscal-month.calendar.initialize",
    entityType: "FiscalMonthCalendar",
    entityId: String(year),
    meta: {
      reasonCode: alreadyInitialized ? "MANUAL_INIT_NOOP_ALREADY_EXISTS" : "MANUAL_INIT_YEAR",
      traceId: trace.traceId,
      requestId: trace.requestId,
      correlationId: trace.correlationId,
      requestPath: trace.requestPath,
      requestMethod: trace.requestMethod,
      beforeHash: hashAuditState(beforeState),
      afterHash: hashAuditState(afterState),
      year,
      months,
      alreadyInitialized,
      initializedYearsCount: saved.length,
      actorRole: user?.role || null,
    },
  });

  return NextResponse.json({
    year,
    initialized: !alreadyInitialized,
    alreadyInitialized,
    months,
    initializedYears: saved,
  });
}
