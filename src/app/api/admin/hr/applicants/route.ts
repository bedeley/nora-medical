import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { normalizeAuditText } from "@/lib/hr-hiring-utils";

const applicantSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().min(5).optional().or(z.literal("")),
  resumeUrl: z.string().url().optional().or(z.literal("")),
  source: z.string().optional().or(z.literal("")),
  sourcePage: z.string().optional().or(z.literal("")),
  section: z.string().optional().or(z.literal("")),
  operation: z.string().optional().or(z.literal("")),
  resultSummary: z.string().optional().or(z.literal("")),
});

function normalizeOptional(value?: string) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

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
  const q = searchParams.get("q")?.trim() || "";
  const includeHired = searchParams.get("includeHired") === "1";

  const applicants = await prisma.applicant.findMany({
    where: {
      ...(q
        ? {
            OR: [
              { firstName: { contains: q, mode: "insensitive" } },
              { lastName: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              { phone: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(includeHired ? {} : { applications: { none: { stage: "HIRED" } } }),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return NextResponse.json({ rows: applicants });
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = applicantSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const applicant = await prisma.applicant.create({
      data: {
        firstName: parsed.data.firstName.trim(),
        lastName: parsed.data.lastName.trim(),
        email: normalizeOptional(parsed.data.email),
        phone: normalizeOptional(parsed.data.phone),
        resumeUrl: normalizeOptional(parsed.data.resumeUrl),
        source: normalizeOptional(parsed.data.source),
      },
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_APPLICANT_CREATE",
        entityType: "APPLICANT",
        entityId: applicant.id,
        meta: {
          actor: { id: user.id, role: user.role },
          sourcePage: normalizeAuditText(parsed.data.sourcePage, "admin/hr/hiring"),
          section: normalizeAuditText(parsed.data.section, "applicants"),
          operation: normalizeAuditText(parsed.data.operation, "create_applicant"),
          before: null,
          after: {
            firstName: applicant.firstName,
            lastName: applicant.lastName,
            email: applicant.email,
            phone: applicant.phone,
            source: applicant.source,
          },
          status: "SUCCESS",
          resultSummary: normalizeAuditText(parsed.data.resultSummary, "Applicant created successfully."),
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(applicant);
  } catch (err) {
    console.error("Error creating applicant:", err);
    return NextResponse.json({ error: "Failed to create applicant" }, { status: 500 });
  }
}
