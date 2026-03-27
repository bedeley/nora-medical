import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { prisma } from "@/lib/prisma";
import {
  formatPaystubDateRange,
  formatPaystubMoney,
  getPaystubCurrentBreakdownRows,
  getPaystubRoleSummary,
  getPaystubYtdBreakdownRows,
  num,
  type PaystubYtdTotals,
} from "@/lib/hr-paystub-utils";

function periodKey(start: Date, end: Date) {
  return `${start.toISOString()}|${end.toISOString()}`;
}

function sanitizePdfText(value: string) {
  return value.replace(/[^\x20-\x7E]/g, "?");
}

type YtdPayslipRow = {
  employeeId: string;
  payrollRunId: string;
  grossPay: unknown;
  netPay: unknown;
  lineItems: Record<string, unknown> | null | undefined;
  payrollRun: {
    periodStart: Date;
    periodEnd: Date;
    status: string;
    runType: string | null;
    createdAt: Date;
  } | null;
};

function buildEmployeeYtdTotals(
  ytdPayslips: YtdPayslipRow[],
  currentPayrollRunId: string,
  periodEnd: Date,
) {
  const payslipsByEmployee = new Map<string, YtdPayslipRow[]>();
  for (const slip of ytdPayslips) {
    const rows = payslipsByEmployee.get(slip.employeeId) || [];
    rows.push(slip);
    payslipsByEmployee.set(slip.employeeId, rows);
  }

  const totals: Record<string, PaystubYtdTotals> = {};

  for (const [employeeId, employeePayslips] of payslipsByEmployee.entries()) {
    const regularRunsByPeriod = new Map<string, { id: string; score: number; createdAt: Date }>();

    for (const slip of employeePayslips) {
      const run = slip.payrollRun;
      if (!run) continue;
      if (run.runType !== "REGULAR") continue;
      if (run.status !== "FINALIZED" && run.status !== "PAID") continue;
      const key = periodKey(run.periodStart, run.periodEnd);
      const score = run.status === "PAID" ? 2 : 1;
      const existing = regularRunsByPeriod.get(key);
      if (
        !existing ||
        score > existing.score ||
        (score === existing.score && run.createdAt > existing.createdAt)
      ) {
        regularRunsByPeriod.set(key, {
          id: slip.payrollRunId,
          score,
          createdAt: run.createdAt,
        });
      }
    }

    const eligiblePayslips = employeePayslips.filter((slip) => {
      const run = slip.payrollRun;
      if (!run) return false;
      const runPeriodEnd = run.periodEnd || new Date();
      if (slip.payrollRunId === currentPayrollRunId) return true;
      if (runPeriodEnd >= periodEnd) return false;
      if (run.runType === "ADJUSTMENT") {
        return run.status === "FINALIZED" || run.status === "PAID";
      }
      if (run.runType === "REGULAR") {
        const selected = regularRunsByPeriod.get(periodKey(run.periodStart, run.periodEnd));
        return selected?.id === slip.payrollRunId;
      }
      return false;
    });

    totals[employeeId] = eligiblePayslips.reduce<PaystubYtdTotals>(
      (acc, slip) => {
        const lineItems = slip.lineItems as Record<string, unknown> | null | undefined;
        return {
          gross: acc.gross + num(slip.grossPay),
          net: acc.net + num(slip.netPay),
          tax: acc.tax + num(lineItems?.tax),
          pension: acc.pension + num(lineItems?.pension),
          deductions:
            acc.deductions +
            Math.max(0, num(lineItems?.deductions ?? num(slip.grossPay) - num(slip.netPay))),
        };
      },
      { gross: 0, net: 0, deductions: 0, tax: 0, pension: 0 },
    );
  }

  return totals;
}

export async function getPayrollRunYtdTotalsForEmployees(input: {
  employeeIds: string[];
  payrollRunId: string;
  periodEnd: Date;
}) {
  const employeeIds = Array.from(new Set(input.employeeIds.filter(Boolean)));
  if (!employeeIds.length) return {};

  const periodEnd = input.periodEnd || new Date();
  const yearStart = new Date(periodEnd.getFullYear(), 0, 1);
  const yearEnd = new Date(periodEnd.getFullYear(), 11, 31, 23, 59, 59, 999);

  const ytdPayslips = await prisma.payslip.findMany({
    where: {
      employeeId: { in: employeeIds },
      payrollRun: {
        periodEnd: {
          gte: yearStart,
          lte: yearEnd,
        },
      },
    },
    select: {
      payrollRunId: true,
      grossPay: true,
      netPay: true,
      lineItems: true,
      payrollRun: {
        select: {
          periodStart: true,
          periodEnd: true,
          status: true,
          runType: true,
          createdAt: true,
        },
      },
    },
  });

  return buildEmployeeYtdTotals(
    ytdPayslips as YtdPayslipRow[],
    input.payrollRunId,
    periodEnd,
  );
}

async function computePaystubYtdTotals(payslip: {
  payrollRunId: string;
  employeeId: string;
  payrollRun: {
    periodStart: Date;
    periodEnd: Date;
    status: string;
    runType?: string | null;
  };
}) {
  const totals = await getPayrollRunYtdTotalsForEmployees({
    employeeIds: [payslip.employeeId],
    payrollRunId: payslip.payrollRunId,
    periodEnd: payslip.payrollRun.periodEnd || new Date(),
  });
  return totals[payslip.employeeId] || { gross: 0, net: 0, deductions: 0, tax: 0, pension: 0 };
}

export async function getPaystubDetailData(payslipId: string) {
  const payslip = await prisma.payslip.findUnique({
    where: { id: payslipId },
    select: {
      id: true,
      employeeId: true,
      payrollRunId: true,
      grossPay: true,
      netPay: true,
      lineItems: true,
      createdAt: true,
      employee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          department: true,
          position: true,
        },
      },
      payrollRun: {
        select: {
          id: true,
          periodStart: true,
          periodEnd: true,
          status: true,
          runType: true,
        },
      },
    },
  });

  if (!payslip) return null;

  const ytdTotals = await computePaystubYtdTotals({
    payrollRunId: payslip.payrollRunId,
    employeeId: payslip.employeeId,
    payrollRun: {
      periodStart: payslip.payrollRun.periodStart,
      periodEnd: payslip.payrollRun.periodEnd,
      status: payslip.payrollRun.status,
      runType: payslip.payrollRun.runType,
    },
  });

  return { payslip, ytdTotals };
}

export async function buildPaystubPdf(input: {
  payslip: NonNullable<Awaited<ReturnType<typeof getPaystubDetailData>>>["payslip"];
  ytdTotals: PaystubYtdTotals;
}) {
  const { payslip, ytdTotals } = input;
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const margin = 44;
  const contentWidth = 612 - margin * 2;
  const currentRows = getPaystubCurrentBreakdownRows({
    grossPay: payslip.grossPay,
    netPay: payslip.netPay,
    lineItems: payslip.lineItems as Record<string, unknown> | null | undefined,
  });
  const ytdRows = getPaystubYtdBreakdownRows(ytdTotals);

  const drawText = (
    text: string,
    x: number,
    y: number,
    size = 11,
    isBold = false,
    color = rgb(0, 0, 0),
  ) => {
    page.drawText(sanitizePdfText(text), {
      x,
      y,
      size,
      font: isBold ? bold : font,
      color,
    });
  };

  const drawMetricRows = (rows: Array<{ label: string; value: number }>, startY: number) => {
    let y = startY;
    for (const row of rows) {
      page.drawLine({
        start: { x: margin + 18, y: y - 8 },
        end: { x: margin + contentWidth - 18, y: y - 8 },
        thickness: 0.5,
        color: rgb(0.88, 0.9, 0.92),
      });
      drawText(row.label, margin + 18, y, 10, false, rgb(0.35, 0.35, 0.35));
      const value = formatPaystubMoney(row.value);
      const valueWidth = bold.widthOfTextAtSize(sanitizePdfText(value), 10);
      drawText(value, margin + contentWidth - 18 - valueWidth, y, 10, true, rgb(0.1, 0.1, 0.1));
      y -= 22;
    }
  };

  const drawSection = (title: string, y: number, rows: Array<{ label: string; value: number }>) => {
    page.drawRectangle({
      x: margin,
      y: y + 16,
      width: contentWidth,
      height: 24,
      color: rgb(0.94, 0.97, 0.98),
    });
    drawText(title, margin + 16, y + 24, 11, true, rgb(0.2, 0.28, 0.3));
    page.drawRectangle({
      x: margin,
      y: y - rows.length * 22 - 6,
      width: contentWidth,
      height: rows.length * 22 + 22,
      borderColor: rgb(0.86, 0.88, 0.9),
      borderWidth: 1,
    });
    drawMetricRows(rows, y + 4);
  };

  page.drawRectangle({
    x: margin,
    y: 706,
    width: contentWidth,
    height: 58,
    color: rgb(0.96, 0.98, 0.99),
  });
  drawText("Noralls Medical Supplies", margin + 18, 742, 17, true, rgb(0.13, 0.2, 0.24));
  drawText("Official paystub", margin + 18, 724, 10, false, rgb(0.38, 0.45, 0.5));
  drawText(`Paystub ID: ${payslip.id}`, margin + 330, 742, 9, false, rgb(0.34, 0.4, 0.44));
  drawText(
    `Run status: ${payslip.payrollRun.status}`,
    margin + 330,
    727,
    9,
    false,
    rgb(0.34, 0.4, 0.44),
  );

  page.drawRectangle({
    x: margin,
    y: 606,
    width: contentWidth,
    height: 78,
    borderColor: rgb(0.86, 0.88, 0.9),
    borderWidth: 1,
  });
  drawText("Employee", margin + 16, 664, 9, false, rgb(0.45, 0.45, 0.45));
  drawText(
    `${payslip.employee.firstName} ${payslip.employee.lastName}`,
    margin + 16,
    644,
    12,
    true,
  );
  drawText(
    getPaystubRoleSummary(payslip.employee.position, payslip.employee.department),
    margin + 16,
    626,
    9,
    false,
    rgb(0.45, 0.45, 0.45),
  );
  drawText("Payroll run", margin + 310, 664, 9, false, rgb(0.45, 0.45, 0.45));
  drawText(
    formatPaystubDateRange(payslip.payrollRun.periodStart, payslip.payrollRun.periodEnd),
    margin + 310,
    644,
    11,
    true,
  );
  drawText(
    `Run type: ${payslip.payrollRun.runType || "REGULAR"}`,
    margin + 310,
    626,
    9,
    false,
    rgb(0.45, 0.45, 0.45),
  );

  drawSection("Current period", 548, currentRows);
  drawSection("Year to date", 278, ytdRows);

  drawText(
    "This paystub is confidential and intended for the employee named above.",
    margin,
    74,
    9,
    false,
    rgb(0.4, 0.4, 0.4),
  );

  return Buffer.from(await pdfDoc.save());
}
