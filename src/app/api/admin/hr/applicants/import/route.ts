import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

const rowSchema = z.object({
  firstname: z.string().min(1),
  lastname: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().min(5).optional().or(z.literal("")),
  source: z.string().optional().or(z.literal("")),
  resumeurl: z.string().url().optional().or(z.literal("")),
});

const payloadSchema = z.object({
  rows: z.array(z.record(z.string(), z.string())).min(1),
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

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const errors: string[] = [];
  let created = 0;
  let skipped = 0;

  for (const [index, raw] of parsed.data.rows.entries()) {
    const normalized = Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [key.trim().toLowerCase(), String(value || "").trim()])
    );
    const row = rowSchema.safeParse(normalized);
    if (!row.success) {
      errors.push(`Row ${index + 1}: Invalid data.`);
      continue;
    }

    const email = normalizeOptional(row.data.email);
    const phone = normalizeOptional(row.data.phone);
    const lookup = [];
    if (email) lookup.push({ email });
    if (phone) lookup.push({ phone });
    const existing = lookup.length
      ? await prisma.applicant.findFirst({ where: { OR: lookup } })
      : null;
    if (existing) {
      skipped += 1;
      continue;
    }

    try {
      await prisma.applicant.create({
        data: {
          firstName: row.data.firstname.trim(),
          lastName: row.data.lastname.trim(),
          email,
          phone,
          source: normalizeOptional(row.data.source),
          resumeUrl: normalizeOptional(row.data.resumeurl),
        },
      });
      created += 1;
    } catch {
      errors.push(`Row ${index + 1}: Failed to create applicant.`);
    }
  }

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "HR_APPLICANT_IMPORT",
      entityType: "APPLICANT",
      entityId: "bulk",
      meta: { created, skipped, errors: errors.length },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({ created, skipped, errors });
}
