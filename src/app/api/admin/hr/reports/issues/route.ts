import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function toCsv(rows: string[][]) {
  return rows
    .map((row) =>
      row
        .map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`)
        .join(",")
    )
    .join("\n");
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
  const statusRaw = searchParams.get("status")?.trim().toUpperCase() || "";
  const allowed = new Set(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]);
  const status = allowed.has(statusRaw) ? statusRaw : "";

  const issues = await prisma.staffIssue.findMany({
    where: status ? { status: status as "OPEN" } : undefined,
    include: { employee: true },
    orderBy: { createdAt: "desc" },
  });

  const rows = [
    ["IssueId", "Employee", "Type", "Severity", "Status", "OpenedAt", "ClosedAt"],
    ...issues.map((issue) => [
      issue.id,
      `${issue.employee.firstName} ${issue.employee.lastName}`,
      issue.type,
      issue.severity,
      issue.status,
      issue.createdAt.toISOString().slice(0, 10),
      issue.closedAt ? issue.closedAt.toISOString().slice(0, 10) : "",
    ]),
  ];

  const csv = toCsv(rows);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=hr_issues_${Date.now()}.csv`,
    },
  });
}
