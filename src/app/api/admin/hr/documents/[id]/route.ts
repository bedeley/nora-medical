import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

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
          employeeId: doc.employeeId,
          title: doc.title,
          fileType: doc.fileType,
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
