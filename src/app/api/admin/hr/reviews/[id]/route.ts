import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

const updateSchema = z.object({
  rating: z.enum(["EXCEEDS", "MEETS", "NEEDS_IMPROVEMENT", "UNSATISFACTORY"]).optional(),
  summary: z.string().optional().or(z.literal("")),
  strengths: z.string().optional().or(z.literal("")),
  improvements: z.string().optional().or(z.literal("")),
  goals: z.string().optional().or(z.literal("")),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.rating) data.rating = parsed.data.rating;
  if ("summary" in parsed.data) data.summary = parsed.data.summary?.trim() || null;
  if ("strengths" in parsed.data) data.strengths = parsed.data.strengths?.trim() || null;
  if ("improvements" in parsed.data) data.improvements = parsed.data.improvements?.trim() || null;
  if ("goals" in parsed.data) data.goals = parsed.data.goals?.trim() || null;

  try {
    const review = await prisma.performanceReview.update({
      where: { id: resolvedParams.id },
      data,
      include: { employee: true },
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_REVIEW_UPDATE",
        entityType: "PERFORMANCE_REVIEW",
        entityId: review.id,
        meta: {
          employeeId: review.employeeId,
          rating: review.rating,
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(review);
  } catch (err) {
    console.error("Error updating review:", err);
    return NextResponse.json({ error: "Failed to update review" }, { status: 500 });
  }
}
