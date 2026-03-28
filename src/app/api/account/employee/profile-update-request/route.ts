import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import {
  buildEmployeePortalContactRequestKey,
  EMPLOYEE_PORTAL_HOME_PAGE,
} from "@/lib/employee-portal";

const requestSchema = z.object({
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().trim().min(7).max(30).optional().or(z.literal("")),
  reason: z.string().trim().min(5).max(500),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const parsed = requestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request details." }, { status: 400 });
  }

  const employee = await prisma.employee.findFirst({
    where: { userId: user.id },
    select: { id: true, email: true, phone: true, firstName: true, lastName: true },
  });
  if (!employee) {
    return NextResponse.json({ error: "Employee profile not found." }, { status: 404 });
  }

  const requestedEmail = parsed.data.email?.trim() || null;
  const requestedPhone = parsed.data.phone?.trim() || null;
  if (!requestedEmail && !requestedPhone) {
    return NextResponse.json({ error: "Enter at least one updated contact value." }, { status: 400 });
  }

  const key = buildEmployeePortalContactRequestKey(employee.id);
  const requestedAt = new Date().toISOString();
  await prisma.siteSetting.upsert({
    where: { key },
    update: {
      value: {
        requestedEmail,
        requestedPhone,
        reason: parsed.data.reason.trim(),
        status: "PENDING",
        requestedAt,
        requestedByUserId: user.id,
      } as Prisma.InputJsonValue,
    },
    create: {
      key,
      value: {
        requestedEmail,
        requestedPhone,
        reason: parsed.data.reason.trim(),
        status: "PENDING",
        requestedAt,
        requestedByUserId: user.id,
      } as Prisma.InputJsonValue,
    },
  });

  await recordAuditLog({
    actorId: user.id,
    action: "EMPLOYEE_PROFILE_UPDATE_REQUEST",
    entityType: "EMPLOYEE",
    entityId: employee.id,
    meta: {
      page: EMPLOYEE_PORTAL_HOME_PAGE,
      sourcePage: EMPLOYEE_PORTAL_HOME_PAGE,
      section: "employee-portal-profile",
      operation: "request_contact_update",
      before: {
        email: employee.email,
        phone: employee.phone,
      },
      after: {
        requestedEmail,
        requestedPhone,
        reason: parsed.data.reason.trim(),
        status: "PENDING",
      },
      status: "SUCCESS",
      resultSummary: "Contact update request submitted successfully.",
    },
  });

  return NextResponse.json({
    ok: true,
    requestedAt,
    status: "PENDING",
  });
}
