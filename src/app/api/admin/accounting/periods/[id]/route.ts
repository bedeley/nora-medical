import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { buildPeriodSnapshot } from "@/lib/accounting-snapshots";
import { extractAuditTrace, hashAuditState } from "@/lib/accounting-period-audit";

const patchSchema = z.object({
  status: z.enum(["OPEN", "CLOSED"]),
  checklistConfirmed: z.boolean().optional(),
  overrideReason: z.string().trim().max(500).optional(),
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

function parseBooleanSetting(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function parseYearList(value: unknown) {
  if (!Array.isArray(value)) return [] as number[];
  return Array.from(
    new Set(
      value
        .map((v) => Number(v))
        .filter((n) => Number.isInteger(n) && n >= 2000 && n <= 2100),
    ),
  );
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  try {
    const trace = extractAuditTrace(req);
    const body = await req.json();
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const period = await prisma.fiscalPeriod.findUnique({
      where: { id: params.id },
    });
    if (!period) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (parsed.data.status === "OPEN") {
      const reopenReason = parsed.data.overrideReason?.trim() || "";
      if (reopenReason.length < 8) {
        return NextResponse.json(
          { error: "Reopen requires a reason of at least 8 characters." },
          { status: 400 },
        );
      }
      const [fiscalWindowSetting, enforceFinalizedLockSetting, finalizedYearsSetting] = await Promise.all([
        prisma.appSetting.findUnique({
          where: { key: "accounting.reopen.fiscalWindowDays" },
          select: { value: true },
        }),
        prisma.appSetting.findUnique({
          where: { key: "accounting.reopen.enforceFinalizedYearLock" },
          select: { value: true },
        }),
        prisma.appSetting.findUnique({
          where: { key: "accounting.reopen.finalizedFiscalYears" },
          select: { value: true },
        }),
      ]);
      const fiscalWindowDays = parseReopenWindowDays(fiscalWindowSetting?.value, 30);
      const deadline = new Date(new Date(period.endDate).getTime() + fiscalWindowDays * 86_400_000);
      const now = new Date();
      if (now.getTime() > deadline.getTime()) {
        return NextResponse.json(
          { error: `Reopen window expired. Fiscal periods can be reopened only within ${fiscalWindowDays} day(s) after period end.` },
          { status: 400 },
        );
      }
      const enforceFinalizedYearLock = parseBooleanSetting(enforceFinalizedLockSetting?.value, false);
      const finalizedFiscalYears = parseYearList(finalizedYearsSetting?.value);
      const periodYear = new Date(period.endDate).getUTCFullYear();
      if (enforceFinalizedYearLock && finalizedFiscalYears.includes(periodYear)) {
        return NextResponse.json(
          { error: `Fiscal year ${periodYear} is finalized and hard-locked for reopen.` },
          { status: 400 },
        );
      }
    }

    if (parsed.data.status === "CLOSED") {
      const overrideReason = parsed.data.overrideReason?.trim() || "";
      const now = new Date();
      const isEarlyClose = new Date(period.endDate).getTime() > now.getTime();
      if (isEarlyClose) {
        if ((session.user as AuthenticatedUser).role !== "ADMIN") {
          return NextResponse.json(
            { error: "Early fiscal period close is restricted to admin override." },
            { status: 403 },
          );
        }
        if (overrideReason.length < 20) {
          return NextResponse.json(
            { error: "Early fiscal period close requires an override reason of at least 20 characters." },
            { status: 400 },
          );
        }
      }
      if (!parsed.data.checklistConfirmed && !overrideReason) {
        return NextResponse.json(
          { error: "Complete the close checklist or provide an override reason." },
          { status: 400 },
        );
      }
      const draftCount = await prisma.journalEntry.count({
        where: {
          status: "DRAFT",
          entryDate: {
            gte: period.startDate,
            lte: period.endDate,
          },
        },
      });
      if (draftCount > 0) {
        return NextResponse.json(
          { error: `Cannot close period with ${draftCount} draft journal entr${draftCount === 1 ? "y" : "ies"}.` },
          { status: 400 },
        );
      }
    }

    const updated = await prisma.fiscalPeriod.update({
      where: { id: params.id },
      data: { status: parsed.data.status },
    });
    const beforeState = {
      id: period.id,
      name: period.name,
      status: period.status,
      startDate: period.startDate.toISOString(),
      endDate: period.endDate.toISOString(),
    };
    const afterState = {
      id: updated.id,
      name: updated.name,
      status: updated.status,
      startDate: updated.startDate.toISOString(),
      endDate: updated.endDate.toISOString(),
    };
    const overrideReason = parsed.data.overrideReason?.trim() || null;
    const reasonCode =
      parsed.data.status === "CLOSED"
        ? new Date(period.endDate).getTime() > Date.now()
          ? "EARLY_CLOSE_OVERRIDE"
          : overrideReason
            ? "MANUAL_OVERRIDE_CLOSE"
            : "CHECKLIST_CONFIRMED_CLOSE"
        : "MANUAL_REOPEN_WITHIN_WINDOW";

    if (parsed.data.status === "CLOSED") {
      const existingSnapshot = await prisma.periodCloseSnapshot.findFirst({
        where: { periodId: updated.id },
      });
      if (!existingSnapshot) {
        const snapshotData = await buildPeriodSnapshot(updated.id);
        if (snapshotData) {
          await prisma.periodCloseSnapshot.create({
            data: {
              periodId: updated.id,
              data: snapshotData,
            },
          });
        }
      }
    }

    await recordAuditLog({
      actorId: (session.user as AuthenticatedUser).id,
      action: parsed.data.status === "CLOSED" ? "fiscal-period.close" : "fiscal-period.open",
      entityType: "FiscalPeriod",
      entityId: updated.id,
      meta: {
        reasonCode,
        traceId: trace.traceId,
        requestId: trace.requestId,
        correlationId: trace.correlationId,
        requestPath: trace.requestPath,
        requestMethod: trace.requestMethod,
        actorRole: (session.user as AuthenticatedUser).role || null,
        beforeStatus: period.status,
        afterStatus: updated.status,
        beforeHash: hashAuditState(beforeState),
        afterHash: hashAuditState(afterState),
        name: updated.name,
        checklistConfirmed: Boolean(parsed.data.checklistConfirmed),
        overrideReason,
        earlyClose: parsed.data.status === "CLOSED" ? new Date(period.endDate).getTime() > Date.now() : false,
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Accounting period update error:", error);
    return NextResponse.json({ error: "Failed to update period" }, { status: 500 });
  }
}
