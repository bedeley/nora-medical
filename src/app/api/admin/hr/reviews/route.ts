import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

const createSchema = z.object({
  employeeId: z.string().min(1),
  rating: z.enum(["EXCEEDS", "MEETS", "NEEDS_IMPROVEMENT", "UNSATISFACTORY"]).optional(),
  periodStart: z.string().min(1),
  periodEnd: z.string().min(1),
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

export async function GET(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const employeeId = searchParams.get("employeeId")?.trim() || "";

  const rows = await prisma.performanceReview.findMany({
    where: employeeId ? { employeeId } : undefined,
    include: { employee: true },
    orderBy: { periodEnd: "desc" },
    take: 200,
  });

  return NextResponse.json({ rows });
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const periodStart = new Date(parsed.data.periodStart);
  const periodEnd = new Date(parsed.data.periodEnd);
  if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
    return NextResponse.json({ error: "Invalid review period." }, { status: 400 });
  }
  if (periodEnd < periodStart) {
    return NextResponse.json({ error: "Period end must be after period start." }, { status: 400 });
  }

  try {
    const review = await prisma.performanceReview.create({
      data: {
        employeeId: parsed.data.employeeId,
        reviewerId: user.id,
        rating: parsed.data.rating ?? "MEETS",
        periodStart,
        periodEnd,
        summary: parsed.data.summary?.trim() || null,
        strengths: parsed.data.strengths?.trim() || null,
        improvements: parsed.data.improvements?.trim() || null,
        goals: parsed.data.goals?.trim() || null,
      },
      include: { employee: true },
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_REVIEW_CREATE",
        entityType: "PERFORMANCE_REVIEW",
        entityId: review.id,
        meta: {
          employeeId: review.employeeId,
          rating: review.rating,
          periodStart: review.periodStart.toISOString(),
          periodEnd: review.periodEnd.toISOString(),
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(review);
  } catch (err) {
    console.error("Error creating review:", err);
    return NextResponse.json({ error: "Failed to create review" }, { status: 500 });
  }
}
