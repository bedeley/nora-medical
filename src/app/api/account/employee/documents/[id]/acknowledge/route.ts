import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import {
  buildEmployeePortalDocumentAcknowledgementKey,
  EMPLOYEE_PORTAL_DOCUMENTS_PAGE,
  getEmployeePortalDocument,
} from "@/lib/employee-portal";
import { prisma } from "@/lib/prisma";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const resolvedParams = await params;
  if (!resolvedParams?.id) {
    return NextResponse.json({ error: "Document id is required." }, { status: 400 });
  }

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const doc = await getEmployeePortalDocument(user.id, resolvedParams.id);
  if (!doc || !doc.employeeVisible) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  const key = buildEmployeePortalDocumentAcknowledgementKey(doc.id, user.id);
  const acknowledgedAt = new Date().toISOString();
  await prisma.siteSetting.upsert({
    where: { key },
    update: {
      value: {
        acknowledged: true,
        acknowledgedAt,
        acknowledgedByUserId: user.id,
      } as Prisma.InputJsonValue,
    },
    create: {
      key,
      value: {
        acknowledged: true,
        acknowledgedAt,
        acknowledgedByUserId: user.id,
      } as Prisma.InputJsonValue,
    },
  });

  await recordAuditLog({
    actorId: user.id,
    action: "HR_DOCUMENT_ACKNOWLEDGE",
    entityType: "EMPLOYEE_DOCUMENT",
    entityId: doc.id,
    meta: {
      page: EMPLOYEE_PORTAL_DOCUMENTS_PAGE,
      sourcePage: EMPLOYEE_PORTAL_DOCUMENTS_PAGE,
      section: "employee-portal-documents",
      operation: "acknowledge_document",
      before: { acknowledged: false },
      after: {
        acknowledged: true,
        acknowledgedAt,
        title: doc.title,
      },
      status: "SUCCESS",
      resultSummary: "Employee document acknowledged successfully.",
    },
  });

  return NextResponse.json({ ok: true, acknowledgedAt });
}
