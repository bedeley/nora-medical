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
  const q = String(searchParams.get("q") || "")
    .trim()
    .toLowerCase();
  const stageFilter = String(searchParams.get("stage") || "all").trim().toUpperCase();
  const jobFilter = String(searchParams.get("job") || "all").trim();
  const showHired = searchParams.get("showHired") === "1";

  const rows = await prisma.application.findMany({
    include: {
      applicant: true,
      jobPosting: true,
    },
    orderBy: { createdAt: "desc" },
    take: MAX_EXPORT_ROWS,
  });

  const filtered = rows.filter((row) => {
    if (!showHired && row.stage === "HIRED") return false;
    if (stageFilter !== "ALL" && stageFilter !== row.stage) return false;
    if (jobFilter !== "all" && jobFilter !== row.jobPostingId) return false;
    if (!q) return true;
    const applicantName = `${row.applicant.firstName} ${row.applicant.lastName}`.toLowerCase();
    const applicantEmail = String(row.applicant.email || "").toLowerCase();
    const applicantPhone = String(row.applicant.phone || "").toLowerCase();
    const role = String(row.jobPosting.title || "").toLowerCase();
    return (
      applicantName.includes(q) ||
      applicantEmail.includes(q) ||
      applicantPhone.includes(q) ||
      role.includes(q)
    );
  });

  const header = ["applicant", "email", "phone", "job", "stage", "createdAt", "notes"];
  const csvRows = filtered.map((row) => [
    `${row.applicant.firstName} ${row.applicant.lastName}`.trim(),
    row.applicant.email || "",
    row.applicant.phone || "",
    row.jobPosting.title || "",
    row.stage,
    row.createdAt ? row.createdAt.toISOString() : "",
    row.notes || "",
  ]);
  const csv = [header, ...csvRows]
    .map((line) => line.map((v) => escapeCsv(String(v))).join(","))
    .join("\n");
  const fileName = `hr-applications-${timestampLabel()}.csv`;
  const byteSize = Buffer.byteLength(csv, "utf8");
  const scopeSnapshot = `search=${q || "-"}; stage=${stageFilter.toLowerCase()}; job=${jobFilter}; showHired=${showHired ? "yes" : "no"}`;

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "HR_HIRING_EXPORT_APPLICATIONS_CSV",
      entityType: "HRHiringExport",
      entityId: "applications",
      meta: {
        actor: { id: user.id, role: user.role },
        sourcePage: "admin/hr/hiring",
        section: "applications",
        operation: "export_applications_csv",
        fileName,
        format: "csv",
        rowCount: csvRows.length,
        columnCount: header.length,
        byteSize,
        scopeSnapshot,
        before: {
          search: q || null,
          stageFilter: stageFilter.toLowerCase(),
          jobFilter,
          showHired,
        },
        after: {
          fileName,
          rowCount: csvRows.length,
          columnCount: header.length,
          byteSize,
        },
        status: "SUCCESS",
        resultSummary: "Applications CSV export completed from hiring page.",
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
