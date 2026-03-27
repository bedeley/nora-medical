import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { normalizeAuditText, validateHiringConflict } from "@/lib/hr-hiring-utils";

const updateSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().min(5).optional().or(z.literal("")),
  resumeUrl: z.string().url().optional().or(z.literal("")),
  source: z.string().optional().or(z.literal("")),
  expectedUpdatedAt: z.string().optional().or(z.literal("")),
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

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const applicant = await prisma.applicant.findUnique({
    where: { id: params.id },
    include: {
      applications: {
        include: { jobPosting: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!applicant) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(applicant);
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  if (typeof parsed.data.firstName === "string") data.firstName = parsed.data.firstName.trim();
  if (typeof parsed.data.lastName === "string") data.lastName = parsed.data.lastName.trim();
  if ("email" in parsed.data) data.email = normalizeOptional(parsed.data.email);
  if ("phone" in parsed.data) data.phone = normalizeOptional(parsed.data.phone);
  if ("resumeUrl" in parsed.data) data.resumeUrl = normalizeOptional(parsed.data.resumeUrl);
  if ("source" in parsed.data) data.source = normalizeOptional(parsed.data.source);

  try {
    const existing = await prisma.applicant.findUnique({
      where: { id: params.id },
    });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const conflictCheck = validateHiringConflict(existing.updatedAt, parsed.data.expectedUpdatedAt);
    if (!conflictCheck.ok) {
      return NextResponse.json({ error: conflictCheck.error }, { status: conflictCheck.status });
    }

    const applicant = await prisma.applicant.update({
      where: { id: params.id },
      data,
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_APPLICANT_UPDATE",
        entityType: "APPLICANT",
        entityId: applicant.id,
        meta: {
          actor: { id: user.id, role: user.role },
          sourcePage: normalizeAuditText(parsed.data.sourcePage, "admin/hr/hiring"),
          section: normalizeAuditText(parsed.data.section, "applicants"),
          operation: normalizeAuditText(parsed.data.operation, "update_applicant"),
          before: {
            firstName: existing.firstName,
            lastName: existing.lastName,
            email: existing.email,
            phone: existing.phone,
            resumeUrl: existing.resumeUrl,
            source: existing.source,
          },
          after: {
            firstName: applicant.firstName,
            lastName: applicant.lastName,
            email: applicant.email,
            phone: applicant.phone,
            resumeUrl: applicant.resumeUrl,
            source: applicant.source,
          },
          status: "SUCCESS",
          resultSummary: normalizeAuditText(parsed.data.resultSummary, "Applicant updated successfully."),
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(applicant);
  } catch (err) {
    console.error("Error updating applicant:", err);
    return NextResponse.json({ error: "Failed to update applicant" }, { status: 500 });
  }
}
