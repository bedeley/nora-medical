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
  const start = searchParams.get("start");
  const end = searchParams.get("end");

  const where: Record<string, unknown> = { hireDate: { not: null } };
  if (start || end) {
    const range: Record<string, Date> = {};
    if (start) {
      const s = new Date(start);
      if (!Number.isNaN(s.getTime())) range.gte = s;
    }
    if (end) {
      const e = new Date(end);
      if (!Number.isNaN(e.getTime())) {
        e.setHours(23, 59, 59, 999);
        range.lte = e;
      }
    }
    where.hireDate = range;
  }

  const employees = await prisma.employee.findMany({
    where,
    orderBy: { hireDate: "desc" },
  });

  const rows = [
    ["EmployeeId", "FirstName", "LastName", "Department", "Position", "Status", "HireDate"],
    ...employees.map((employee) => [
      employee.id,
      employee.firstName,
      employee.lastName,
      employee.department ?? "",
      employee.position ?? "",
      employee.status,
      employee.hireDate ? employee.hireDate.toISOString().slice(0, 10) : "",
    ]),
  ];

  const csv = toCsv(rows);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=hr_hires_${Date.now()}.csv`,
    },
  });
}
