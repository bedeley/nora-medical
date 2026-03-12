import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

const escapeCsv = (value: string) => {
  if (!value) return "";
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
};

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const fallbackId = pathParts[pathParts.length - 2];
  const id = params?.id || fallbackId;
  if (!id) {
    return NextResponse.json({ error: "Missing id." }, { status: 400 });
  }

  const run = await prisma.vatFilingRun.findUnique({
    where: { id },
  });
  if (!run) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const summary = run.summary as {
    outputVat: number;
    inputVat: number;
    netVat: number;
    outputBase: number;
    inputBase: number;
    exemptBase: number;
    zeroBase: number;
  };
  const details = run.details as {
    name: string;
    rate: number;
    type: string;
    baseTotal: number;
    vatTotal: number;
  }[];

  const summaryRows = [
    ["Output VAT", summary.outputVat.toFixed(2)],
    ["Input VAT", summary.inputVat.toFixed(2)],
    ["Net VAT", summary.netVat.toFixed(2)],
    ["Output taxable base", summary.outputBase.toFixed(2)],
    ["Input taxable base", summary.inputBase.toFixed(2)],
    ["Zero-rated base", summary.zeroBase.toFixed(2)],
    ["Exempt base", summary.exemptBase.toFixed(2)],
  ];

  const header = ["Tax Code", "Rate", "Type", "Taxable Base", "VAT Total"];
  const rows = details.map((row) => [
    row.name,
    row.rate.toFixed(2),
    row.type,
    row.baseTotal.toFixed(2),
    row.vatTotal.toFixed(2),
  ]);

  const csv = [
    ["VAT Filing Run", run.id],
    ["Start", run.startDate.toISOString().slice(0, 10)],
    ["End", run.endDate.toISOString().slice(0, 10)],
    [],
    ["Summary", "Amount"],
    ...summaryRows,
    [],
    header,
    ...rows,
  ]
    .map((row) => row.map((value) => escapeCsv(String(value))).join(","))
    .join("\n");

  const filename = `vat-filing-run-${run.id}.csv`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
