import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

function toCsv(rows: string[][]) {
  return rows
    .map((row) =>
      row
        .map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`)
        .join(",")
    )
    .join("\n");
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  if (!resolvedParams?.id) {
    return NextResponse.json({ error: "Payroll run id is required" }, { status: 400 });
  }
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const run = await prisma.payrollRun.findUnique({
    where: { id: resolvedParams.id },
    include: { payslips: { include: { employee: true } } },
  });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = [
    ["Employee", "Gross Pay", "Net Pay", "Deductions"],
    ...run.payslips.map((slip) => {
      const gross = Number(slip.grossPay || 0);
      const net = Number(slip.netPay || 0);
      const deductions = Math.max(0, gross - net);
      return [
        `${slip.employee.firstName} ${slip.employee.lastName}`,
        gross.toFixed(2),
        net.toFixed(2),
        deductions.toFixed(2),
      ];
    }),
  ];

  const csv = toCsv(rows);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payroll-${run.id}.csv"`,
    },
  });
}
