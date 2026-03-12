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

export async function GET() {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const employees = await prisma.employee.findMany({
    orderBy: { createdAt: "desc" },
  });

  const rows = [
    [
      "EmployeeId",
      "FirstName",
      "LastName",
      "Email",
      "Phone",
      "Department",
      "Position",
      "Status",
      "HireDate",
      "TerminationDate",
    ],
    ...employees.map((employee) => [
      employee.id,
      employee.firstName,
      employee.lastName,
      employee.email ?? "",
      employee.phone ?? "",
      employee.department ?? "",
      employee.position ?? "",
      employee.status,
      employee.hireDate ? employee.hireDate.toISOString().slice(0, 10) : "",
      employee.terminationDate ? employee.terminationDate.toISOString().slice(0, 10) : "",
    ]),
  ];

  const csv = toCsv(rows);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=hr_staff_${Date.now()}.csv`,
    },
  });
}
