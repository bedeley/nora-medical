import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";

const payrollSchema = z.object({
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  status: z.enum(["DRAFT", "FINALIZED", "PAID", "CANCELLED"]).optional(),
  totalGross: z.number().optional(),
  totalNet: z.number().optional(),
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
  const statusRaw = searchParams.get("status")?.trim() || "";
  const allowedStatuses = new Set(["DRAFT", "FINALIZED", "PAID", "CANCELLED"]);
  const status = allowedStatuses.has(statusRaw) ? statusRaw : "";

  const runs = await prisma.payrollRun.findMany({
    where: status ? { status: status as "DRAFT" } : undefined,
    orderBy: { periodStart: "desc" },
    take: 200,
    include: {
      expense: true,
    },
  });

  return NextResponse.json({ rows: runs });
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = payrollSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const run = await prisma.payrollRun.create({
      data: {
        periodStart: new Date(parsed.data.periodStart),
        periodEnd: new Date(parsed.data.periodEnd),
        status: parsed.data.status ?? "DRAFT",
        runType: "REGULAR",
        totalGross: parsed.data.totalGross ?? 0,
        totalNet: parsed.data.totalNet ?? 0,
        finalizedAt: parsed.data.status && parsed.data.status !== "DRAFT" ? new Date() : null,
      },
    });
    return NextResponse.json(run);
  } catch (err) {
    console.error("Error creating payroll run:", err);
    return NextResponse.json({ error: "Failed to create payroll run" }, { status: 500 });
  }
}
