import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

const reminderActionSchema = z.object({
  actionType: z.enum(["OPEN_HISTORY", "OPEN_LAST_REVIEW_AUDIT", "START_REVIEW"]),
  employeeId: z.string().min(1),
  reviewId: z.string().min(1).optional(),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const parsed = reminderActionSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "HR_REVIEW_REMINDER_ACTION",
      entityType: "PERFORMANCE_REVIEW",
      entityId: parsed.data.reviewId || parsed.data.employeeId,
      meta: {
        sourcePage: "admin/hr/reviews",
        section: "review-reminders",
        operation: parsed.data.actionType.toLowerCase(),
        actorId: user.id,
        targetEmployeeId: parsed.data.employeeId,
        targetReviewId: parsed.data.reviewId || null,
        before: null,
        after: {
          actionType: parsed.data.actionType,
          employeeId: parsed.data.employeeId,
          reviewId: parsed.data.reviewId || null,
        },
        status: "SUCCESS",
        resultSummary: "Reminder action recorded.",
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({ ok: true });
}
