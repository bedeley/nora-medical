import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function toCsvRow(values: Array<string | number | null | undefined>) {
  return values
    .map((value) => {
      const raw = value === null || value === undefined ? "" : String(value);
      const escaped = raw.replace(/"/g, '""');
      return `"${escaped}"`;
    })
    .join(",");
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const run = await prisma.payrollRun.findUnique({
    where: { id: resolvedParams.id },
    include: {
      payslips: {
        include: { employee: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!run) {
    return NextResponse.json({ error: "Payroll run not found" }, { status: 404 });
  }
  if (run.status !== "FINALIZED" && run.status !== "PAID") {
    return NextResponse.json({ error: "Bank export is available after finalize or paid." }, { status: 400 });
  }

  const missing = run.payslips.filter((slip) => {
    const emp = slip.employee;
    return !emp?.bankAccountNumber || !emp?.bankName;
  });
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: "Missing bank details for some employees.",
        missing: missing.map((slip) => ({
          employeeId: slip.employeeId,
          employee: `${slip.employee.firstName} ${slip.employee.lastName}`,
        })),
      },
      { status: 400 }
    );
  }

  const header = [
    "Employee",
    "BankName",
    "BankCode",
    "BankBranch",
    "AccountName",
    "AccountNumber",
    "Amount",
    "PayrollRunId",
  ];
  const rows = run.payslips.map((slip) => [
    `${slip.employee.firstName} ${slip.employee.lastName}`,
    slip.employee.bankName || "",
    slip.employee.bankCode || "",
    slip.employee.bankBranch || "",
    slip.employee.bankAccountName || "",
    slip.employee.bankAccountNumber || "",
    Number(slip.netPay || 0),
    run.id,
  ]);

  const csv = [toCsvRow(header), ...rows.map(toCsvRow)].join("\n");
  const fileName = `payroll-bank-export-${run.id}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}
