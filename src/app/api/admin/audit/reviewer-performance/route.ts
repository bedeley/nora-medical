import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type ReviewerRow = {
  reviewerId: string;
  reviewerName: string;
  reviewedCount: number;
  avgHoursToReview: number;
  assignedOpen: number;
  assignedInProgress: number;
  assignedOverdue: number;
};

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function parseMeta(raw: string | null) {
  if (!raw) return {} as Record<string, unknown>;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const days = Math.max(1, Math.min(365, Number(searchParams.get("days") || 30)));
  const startAt = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await prisma.auditLog.findMany({
    where: {
      deletedAt: null,
      createdAt: { gte: startAt },
    },
    orderBy: { createdAt: "desc" },
    take: 8000,
    select: { id: true, createdAt: true, meta: true },
  });

  const map = new Map<string, ReviewerRow & { _totalReviewHours: number }>();
  const ensure = (id: string, name: string) => {
    if (!map.has(id)) {
      map.set(id, {
        reviewerId: id,
        reviewerName: name || id,
        reviewedCount: 0,
        avgHoursToReview: 0,
        assignedOpen: 0,
        assignedInProgress: 0,
        assignedOverdue: 0,
        _totalReviewHours: 0,
      });
    }
    return map.get(id)!;
  };

  const nowMs = Date.now();
  for (const row of rows) {
    const meta = parseMeta(row.meta);
    const reviewedAt = String(meta.reviewedAt || "").trim();
    const reviewedById = String(meta.reviewedById || "").trim();
    const reviewedByName = String(meta.reviewedByName || "").trim() || "Unknown reviewer";
    if (reviewedAt && reviewedById) {
      const reviewedMs = new Date(reviewedAt).getTime();
      if (!Number.isNaN(reviewedMs)) {
        const target = ensure(reviewedById, reviewedByName);
        target.reviewedCount += 1;
        target._totalReviewHours += Math.max(0, (reviewedMs - row.createdAt.getTime()) / (1000 * 60 * 60));
      }
    }

    const assigneeId = String(meta.reviewTaskAssigneeId || "").trim();
    if (assigneeId) {
      const assigneeName = String(meta.reviewTaskAssigneeName || "").trim() || assigneeId;
      const target = ensure(assigneeId, assigneeName);
      const taskStatus = String(meta.reviewTaskStatus || "OPEN").toUpperCase();
      const isReviewed = Boolean(reviewedAt);
      if (!isReviewed) {
        if (taskStatus === "IN_PROGRESS") target.assignedInProgress += 1;
        else target.assignedOpen += 1;
        const dueAt = String(meta.reviewTaskDueAt || "").trim();
        if (dueAt) {
          const dueMs = new Date(dueAt).getTime();
          if (!Number.isNaN(dueMs) && dueMs < nowMs) target.assignedOverdue += 1;
        }
      }
    }
  }

  const items = [...map.values()]
    .map((row) => ({
      reviewerId: row.reviewerId,
      reviewerName: row.reviewerName,
      reviewedCount: row.reviewedCount,
      avgHoursToReview: row.reviewedCount ? Number((row._totalReviewHours / row.reviewedCount).toFixed(1)) : 0,
      assignedOpen: row.assignedOpen,
      assignedInProgress: row.assignedInProgress,
      assignedOverdue: row.assignedOverdue,
    }))
    .sort((a, b) => b.reviewedCount - a.reviewedCount || a.avgHoursToReview - b.avgHoursToReview)
    .slice(0, 25);

  return NextResponse.json({ days, items });
}
