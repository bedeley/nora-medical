import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { sendEmail } from "@/lib/email";
import { recordAuditLog } from "@/lib/audit-log";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const payloadSchema = z.object({
  email: z.string().email(),
});

function formatMoney(value: number) {
  const formatted = new Intl.NumberFormat("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  return `GHS ${formatted}`;
}

function num(v: unknown) {
  return Number(v || 0);
}

function periodKey(start: Date, end: Date) {
  return `${start.toISOString()}|${end.toISOString()}`;
}

async function computeYtdTotals(payslip: {
  id: string;
  payrollRunId: string;
  employeeId: string;
  payrollRun: { periodStart: Date; periodEnd: Date; status: string; runType?: string };
}) {
  const periodEnd = payslip.payrollRun.periodEnd || new Date();
  const yearStart = new Date(periodEnd.getFullYear(), 0, 1);
  const yearEnd = new Date(periodEnd.getFullYear(), 11, 31, 23, 59, 59, 999);

  const ytdPayslips = await prisma.payslip.findMany({
    where: {
      employeeId: payslip.employeeId,
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

  const regularRunsByPeriod = new Map<string, { id: string }>();
  for (const slip of ytdPayslips) {
    const run = slip.payrollRun;
    if (!run) continue;
    if (run.runType !== "REGULAR") continue;
    if (run.status !== "FINALIZED" && run.status !== "PAID") continue;
    const key = periodKey(run.periodStart, run.periodEnd);
    const existing = regularRunsByPeriod.get(key);
    if (!existing) {
      regularRunsByPeriod.set(key, { id: slip.payrollRunId });
      continue;
    }
    const existingSlip = ytdPayslips.find((item) => item.payrollRunId === existing.id);
    const existingRun = existingSlip?.payrollRun;
    if (!existingRun) {
      regularRunsByPeriod.set(key, { id: slip.payrollRunId });
      continue;
    }
    const score = run.status === "PAID" ? 2 : 1;
    const existingScore = existingRun.status === "PAID" ? 2 : 1;
    if (score > existingScore) {
      regularRunsByPeriod.set(key, { id: slip.payrollRunId });
    } else if (score === existingScore) {
      if (run.createdAt > existingRun.createdAt) {
        regularRunsByPeriod.set(key, { id: slip.payrollRunId });
      }
    }
  }

  const eligiblePayslips = ytdPayslips.filter((slip) => {
    const run = slip.payrollRun;
    if (!run) return false;
    const runPeriodEnd = run.periodEnd || new Date();
    if (slip.payrollRunId === payslip.payrollRunId) return true;
    if (runPeriodEnd >= periodEnd) return false;
    if (run.runType === "ADJUSTMENT") {
      return run.status === "FINALIZED" || run.status === "PAID";
    }
    if (run.runType === "REGULAR") {
      const key = periodKey(run.periodStart, run.periodEnd);
      const selected = regularRunsByPeriod.get(key);
      return selected?.id === slip.payrollRunId;
    }
    return false;
  });

  return eligiblePayslips.reduce(
    (acc, slip) => {
      const gross = num(slip.grossPay);
      const net = num(slip.netPay);
      const lineItems = slip.lineItems as Record<string, unknown> | null | undefined;
      const tax = num(lineItems?.tax);
      const pension = num(lineItems?.pension);
      const deductions = Math.max(0, num(lineItems?.deductions ?? gross - net));
      return {
        gross: acc.gross + gross,
        net: acc.net + net,
        deductions: acc.deductions + deductions,
        tax: acc.tax + tax,
        pension: acc.pension + pension,
      };
    },
    { gross: 0, net: 0, deductions: 0, tax: 0, pension: 0 }
  );
}

async function buildPaystubPdf({
  payslip,
  ytdTotals,
}: {
  payslip: {
    id: string;
    grossPay: number | string;
    netPay: number | string;
    lineItems?: Record<string, number> | null;
    employee: {
      firstName: string;
      lastName: string;
      department?: string | null;
      position?: string | null;
    };
    payrollRun: {
      periodStart: Date;
      periodEnd: Date;
      status: string;
    };
  };
  ytdTotals: { gross: number; net: number; tax: number; pension: number; deductions: number };
}) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const margin = 48;
  const contentWidth = 612 - margin * 2;
  const lineItems = payslip.lineItems ?? {};
  const deductions = Math.max(0, num(lineItems.deductions ?? num(payslip.grossPay) - num(payslip.netPay)));

  const drawText = (
    text: string,
    x: number,
    y: number,
    size = 11,
    isBold = false,
    color = rgb(0, 0, 0)
  ) => {
    page.drawText(text, {
      x,
      y,
      size,
      font: isBold ? bold : font,
      color,
    });
  };

  const drawSectionTitle = (title: string, y: number) => {
    page.drawRectangle({
      x: margin,
      y,
      width: contentWidth,
      height: 22,
      color: rgb(0.94, 0.96, 0.98),
    });
    drawText(title, margin + 12, y + 6, 11, true, rgb(0.2, 0.2, 0.2));
  };

  page.drawRectangle({
    x: margin,
    y: 720,
    width: contentWidth,
    height: 56,
    color: rgb(0.97, 0.98, 0.99),
  });
  drawText("Noralls Medical Supplies", margin + 16, 752, 16, true);
  drawText("Official Paystub", margin + 16, 734, 10, false, rgb(0.4, 0.4, 0.4));
  drawText(`Paystub ID: ${payslip.id}`, margin + 320, 752, 9, false, rgb(0.35, 0.35, 0.35));
  drawText(`Run Status: ${payslip.payrollRun.status}`, margin + 320, 736, 9, false, rgb(0.35, 0.35, 0.35));

  page.drawRectangle({
    x: margin,
    y: 640,
    width: contentWidth,
    height: 64,
    borderColor: rgb(0.86, 0.88, 0.9),
    borderWidth: 1,
  });
  drawText("Employee", margin + 12, 690, 9, false, rgb(0.45, 0.45, 0.45));
  drawText(
    `${payslip.employee.firstName} ${payslip.employee.lastName}`,
    margin + 12,
    672,
    12,
    true
  );
  drawText(
    `${payslip.employee.position || "—"} · ${payslip.employee.department || "—"}`,
    margin + 12,
    654,
    9,
    false,
    rgb(0.45, 0.45, 0.45)
  );
  drawText("Period", margin + 320, 690, 9, false, rgb(0.45, 0.45, 0.45));
  drawText(
    `${payslip.payrollRun.periodStart.toLocaleDateString()} - ${payslip.payrollRun.periodEnd.toLocaleDateString()}`,
    margin + 320,
    672,
    11,
    true
  );

  drawSectionTitle("Current", 594);
  drawSectionTitle("Year to Date", 458);

  const columnPadding = 2;
  const columnGap = 24;
  const columnWidth = (contentWidth - columnGap) / 2;
  const leftX = margin + columnPadding;
  const rightX = margin + columnWidth + columnGap + columnPadding;
  const drawRow = (label: string, value: string, x: number, y: number) => {
    const labelColor = rgb(0.35, 0.35, 0.35);
    const valueColor = rgb(0.1, 0.1, 0.1);
    drawText(label, x, y, 10, false, labelColor);
    const valueWidth = bold.widthOfTextAtSize(value, 10);
    const valueX = x + columnWidth - valueWidth;
    drawText(value, valueX, y, 10, true, valueColor);
  };

  let y = 566;
  drawRow("Gross Pay", formatMoney(num(payslip.grossPay)), leftX, y);
  drawRow("Net Pay", formatMoney(num(payslip.netPay)), rightX, y);
  y -= 26;
  drawRow("Tax", formatMoney(num(lineItems.tax)), leftX, y);
  drawRow("Pension", formatMoney(num(lineItems.pension)), rightX, y);
  y -= 26;
  drawRow("Deductions", formatMoney(deductions), leftX, y);

  y = 430;
  drawRow("Gross Pay", formatMoney(num(ytdTotals.gross)), leftX, y);
  drawRow("Net Pay", formatMoney(num(ytdTotals.net)), rightX, y);
  y -= 26;
  drawRow("Tax", formatMoney(num(ytdTotals.tax)), leftX, y);
  drawRow("Pension", formatMoney(num(ytdTotals.pension)), rightX, y);
  y -= 26;
  drawRow("Deductions", formatMoney(num(ytdTotals.deductions)), leftX, y);

  drawText(
    "This paystub is confidential and intended for the employee named above.",
    margin,
    100,
    9,
    false,
    rgb(0.4, 0.4, 0.4)
  );

  return Buffer.from(await pdfDoc.save());
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const payslip = await prisma.payslip.findUnique({
    where: { id: resolvedParams.id },
    include: { employee: true, payrollRun: true },
  });
  if (!payslip) {
    return NextResponse.json({ error: "Paystub not found" }, { status: 404 });
  }

  const ytdTotals = await computeYtdTotals({
    id: payslip.id,
    payrollRunId: payslip.payrollRunId,
    employeeId: payslip.employeeId,
    payrollRun: {
      periodStart: payslip.payrollRun.periodStart,
      periodEnd: payslip.payrollRun.periodEnd,
      status: payslip.payrollRun.status,
      runType: payslip.payrollRun.runType,
    },
  });

  const pdfBuffer = await buildPaystubPdf({
    payslip: {
      id: payslip.id,
      grossPay: Number(payslip.grossPay || 0),
      netPay: Number(payslip.netPay || 0),
      lineItems: (payslip.lineItems as Record<string, number> | null) || null,
      employee: {
        firstName: payslip.employee.firstName,
        lastName: payslip.employee.lastName,
        department: payslip.employee.department,
        position: payslip.employee.position,
      },
      payrollRun: {
        periodStart: payslip.payrollRun.periodStart,
        periodEnd: payslip.payrollRun.periodEnd,
        status: payslip.payrollRun.status,
      },
    },
    ytdTotals,
  });

  const subject = `Paystub for ${payslip.employee.firstName} ${payslip.employee.lastName}`;
  const text = [
    "Paystub details",
    `Employee: ${payslip.employee.firstName} ${payslip.employee.lastName}`,
    `Period: ${new Date(payslip.payrollRun.periodStart).toLocaleDateString()} - ${new Date(
      payslip.payrollRun.periodEnd
    ).toLocaleDateString()}`,
    `Gross Pay: ${formatMoney(num(payslip.grossPay))}`,
    `Net Pay: ${formatMoney(num(payslip.netPay))}`,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await sendEmail(parsed.data.email, subject, text, undefined, {
    attachments: [
      {
        filename: `paystub-${payslip.id}.pdf`,
        content: pdfBuffer,
        type: "application/pdf",
      },
    ],
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error || "Email failed" }, { status: 500 });
  }

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "PAYSLIP_EMAIL",
      entityType: "PAYSLIP",
      entityId: payslip.id,
      meta: {
        email: parsed.data.email,
        employeeId: payslip.employeeId,
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({ ok: true });
}
