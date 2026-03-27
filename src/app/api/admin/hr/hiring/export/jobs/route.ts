import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";

const MAX_EXPORT_ROWS = 5000;

function escapeCsv(value: string) {
  if (!value) return "";
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

function timestampLabel() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
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
  const q = String(searchParams.get("q") || "").trim();
  const statusRaw = String(searchParams.get("status") || "").trim();
  const allowedStatuses = new Set(["OPEN", "PAUSED", "CLOSED"]);
  const status = allowedStatuses.has(statusRaw) ? statusRaw : "";

  const rows = await prisma.jobPosting.findMany({
    where: {
      ...(status ? { status: status as "OPEN" } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { department: { contains: q, mode: "insensitive" } },
              { location: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: MAX_EXPORT_ROWS,
    select: {
      title: true,
      department: true,
      status: true,
      openedAt: true,
      closedAt: true,
    },
  });

  const header = ["title", "department", "status", "openedAt", "closedAt"];
  const csvRows = rows.map((row) => [
    row.title,
    row.department || "",
    row.status,
    row.openedAt ? row.openedAt.toISOString() : "",
    row.closedAt ? row.closedAt.toISOString() : "",
  ]);
  const csv = [header, ...csvRows]
    .map((line) => line.map((v) => escapeCsv(String(v))).join(","))
    .join("\n");
  const fileName = `hr-job-postings-${timestampLabel()}.csv`;
  const byteSize = Buffer.byteLength(csv, "utf8");
  const scopeSnapshot = `search=${q || "-"}; status=${status || "all"}`;

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "HR_HIRING_EXPORT_JOBS_CSV",
      entityType: "HRHiringExport",
      entityId: "jobs",
      meta: {
        actor: { id: user.id, role: user.role },
        sourcePage: "admin/hr/hiring",
        section: "job-postings",
        operation: "export_jobs_csv",
        fileName,
        format: "csv",
        rowCount: csvRows.length,
        columnCount: header.length,
        byteSize,
        scopeSnapshot,
        before: {
          search: q || null,
          statusFilter: status || "all",
        },
        after: {
          fileName,
          rowCount: csvRows.length,
          columnCount: header.length,
          byteSize,
        },
        status: "SUCCESS",
        resultSummary: "Job postings CSV export completed from hiring page.",
      },
    });
  } catch {
    // best-effort
  }

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}
