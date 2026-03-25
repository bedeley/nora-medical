import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { loadMonthlyCloseRows, toMonthKey } from "@/lib/accounting-periods";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { hasPermission } from "@/lib/permissions";

const approveSchema = z.object({
  entryIds: z.array(z.string().min(1)).min(1),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return hasPermission(role, "journal.approve");
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const parsed = approveSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const entries = await prisma.journalEntry.findMany({
      where: { id: { in: parsed.data.entryIds }, status: "DRAFT", archivedAt: null },
      select: { id: true, entryDate: true, sourceType: true },
    });
    if (entries.length === 0) {
      return NextResponse.json({ approved: 0, requested: parsed.data.entryIds.length, matchedDrafts: 0 });
    }

    const minDateMs = Math.min(...entries.map((entry) => entry.entryDate.getTime()));
    const maxDateMs = Math.max(...entries.map((entry) => entry.entryDate.getTime()));
    const [monthlyRows, fiscalClosedPeriods] = await Promise.all([
      loadMonthlyCloseRows(),
      prisma.fiscalPeriod.findMany({
        where: {
          status: "CLOSED",
          startDate: { lte: new Date(maxDateMs) },
          endDate: { gte: new Date(minDateMs) },
        },
        select: { id: true, name: true, startDate: true, endDate: true },
      }),
    ]);

    const closedMonths = new Set(monthlyRows.map((row) => row.month));
    const blockedEntries = entries.filter((entry) => {
      const monthClosed = closedMonths.has(toMonthKey(entry.entryDate));
      if (monthClosed) return true;
      return fiscalClosedPeriods.some(
        (period) => entry.entryDate.getTime() >= period.startDate.getTime() && entry.entryDate.getTime() <= period.endDate.getTime(),
      );
    });
    if (blockedEntries.length > 0) {
      return NextResponse.json(
        {
          error: "Some selected entries are in closed periods and cannot be posted.",
          closed: blockedEntries.map((entry) => entry.id),
          blockedCount: blockedEntries.length,
        },
        { status: 400 },
      );
    }

    const approveAt = new Date();
    const updated = await prisma.journalEntry.updateMany({
      where: { id: { in: entries.map((e) => e.id) }, status: "DRAFT" },
      data: {
        status: "POSTED",
        approvedById: (session.user as AuthenticatedUser).id,
        approvedAt: approveAt,
      },
    });

    if (entries.length > 0) {
      await prisma.auditLog.createMany({
        data: entries.map((entry) => ({
          actorId: (session.user as AuthenticatedUser).id,
          action: "journal.post",
          entityType: "JournalEntry",
          entityId: entry.id,
          meta: JSON.stringify({
            via: "bulk-approve",
            approvedAt: approveAt.toISOString(),
            sourceType: entry.sourceType,
          }),
        })),
      });
    }
    const sourceTypeCounts = entries.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.sourceType] = (acc[entry.sourceType] || 0) + 1;
      return acc;
    }, {});
    await recordAuditLog({
      actorId: (session.user as AuthenticatedUser).id,
      action: "journal.post.bulk",
      entityType: "JournalEntry",
      entityId: "BULK_APPROVE",
      meta: {
        requestedCount: parsed.data.entryIds.length,
        matchedDraftCount: entries.length,
        approvedCount: updated.count,
        approvedAt: approveAt.toISOString(),
        sourceTypeCounts,
        dateRange: {
          start: new Date(minDateMs).toISOString(),
          end: new Date(maxDateMs).toISOString(),
        },
        sampleEntryIds: entries.slice(0, 20).map((entry) => entry.id),
      },
    });

    return NextResponse.json({
      approved: updated.count,
      requested: parsed.data.entryIds.length,
      matchedDrafts: entries.length,
      sourceTypeCounts,
    });
  } catch (error) {
    console.error("Journal bulk approve error:", error);
    return NextResponse.json({ error: "Failed to approve entries" }, { status: 500 });
  }
}
