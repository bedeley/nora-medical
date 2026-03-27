import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { z } from "zod";

const deleteSchema = z.object({
  sourcePage: z.string().optional().or(z.literal("")),
  section: z.string().optional().or(z.literal("")),
  operation: z.string().optional().or(z.literal("")),
  resultSummary: z.string().optional().or(z.literal("")),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  try {
    const body = await req.json().catch(() => ({}));
    const parsed = deleteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const existing = await prisma.employeeDocument.findUnique({
      where: { id: resolvedParams.id },
      select: {
        id: true,
        employeeId: true,
        title: true,
        fileType: true,
        fileUrl: true,
        uploadedAt: true,
      },
    });
    if (!existing) {
      return NextResponse.json({ error: "Document not found." }, { status: 404 });
    }

    const doc = await prisma.employeeDocument.delete({
      where: { id: resolvedParams.id },
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_DOCUMENT_DELETE",
        entityType: "EMPLOYEE_DOCUMENT",
        entityId: doc.id,
        meta: {
          actor: {
            id: user.id,
            role: user.role,
          },
          sourcePage: parsed.data.sourcePage?.trim() || "admin/hr/staff/[id]",
          section: parsed.data.section?.trim() || "documents",
          operation: parsed.data.operation?.trim() || "delete_document",
          before: {
            employeeId: existing.employeeId,
            title: existing.title,
            fileType: existing.fileType,
            fileUrl: existing.fileUrl,
            uploadedAt: existing.uploadedAt?.toISOString?.() ?? null,
          },
          after: null,
          status: "SUCCESS",
          resultSummary: parsed.data.resultSummary?.trim() || "Employee document removed successfully.",
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Error deleting document:", err);
    return NextResponse.json({ error: "Failed to delete document" }, { status: 500 });
  }
}
