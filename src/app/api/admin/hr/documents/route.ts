import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { isLiveStage } from "@/lib/env";

const createSchema = z.object({
  employeeId: z.string().min(1),
  title: z.string().min(1),
  fileUrl: z.string().min(1),
  fileType: z.string().optional().or(z.literal("")),
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

export async function GET(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const employeeId = searchParams.get("employeeId")?.trim() || "";
  if (!employeeId) {
    return NextResponse.json({ error: "employeeId is required" }, { status: 400 });
  }

  const documents = await prisma.employeeDocument.findMany({
    where: { employeeId },
    orderBy: { uploadedAt: "desc" },
  });

  return NextResponse.json({ rows: documents });
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
  if (isLiveStage()) {
    const rawUrl = parsed.data.fileUrl.trim();
    if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://") || rawUrl.startsWith("/uploads/")) {
      return NextResponse.json({ error: "Public URLs are not allowed for HR documents in production" }, { status: 400 });
    }
  }

  try {
    const doc = await prisma.employeeDocument.create({
      data: {
        employeeId: parsed.data.employeeId,
        title: parsed.data.title.trim(),
        fileUrl: parsed.data.fileUrl.trim(),
        fileType: parsed.data.fileType?.trim() || null,
      },
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_DOCUMENT_CREATE",
        entityType: "EMPLOYEE_DOCUMENT",
        entityId: doc.id,
      meta: {
          actor: {
            id: user.id,
            role: user.role,
          },
          sourcePage: parsed.data.sourcePage?.trim() || "admin/hr/staff/[id]",
          section: parsed.data.section?.trim() || "documents",
          operation: parsed.data.operation?.trim() || "create_document",
          before: null,
          after: {
            employeeId: doc.employeeId,
            title: doc.title,
            fileType: doc.fileType,
            fileUrl: doc.fileUrl,
            uploadedAt: doc.uploadedAt?.toISOString?.() ?? null,
          },
          status: "SUCCESS",
          resultSummary: parsed.data.resultSummary?.trim() || "Employee document added successfully.",
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(doc);
  } catch (err) {
    console.error("Error creating document:", err);
    return NextResponse.json({ error: "Failed to create document" }, { status: 500 });
  }
}
