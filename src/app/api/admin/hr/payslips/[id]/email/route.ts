import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { sendEmail } from "@/lib/email";
import { recordAuditLog } from "@/lib/audit-log";
import { buildPaystubPdf, getPaystubDetailData } from "@/lib/hr-paystub-detail";
import {
  buildPaystubActionAuditMeta,
  formatPaystubDateRange,
  formatPaystubMoney,
  getPaystubCurrentBreakdownRows,
  getPaystubPdfFileName,
} from "@/lib/hr-paystub-utils";

export const runtime = "nodejs";

const payloadSchema = z.object({
  email: z.string().email(),
});

function buildAuditActor(user: AuthenticatedUser) {
  return {
    id: user.id,
    name: user.name || null,
    email: user.email || null,
    role: user.role,
  };
}

async function recordPaystubEmailAudit(input: {
  user: AuthenticatedUser;
  payslip: NonNullable<Awaited<ReturnType<typeof getPaystubDetailData>>>["payslip"];
  recipientEmail: string;
  fileName: string;
  byteSize: number;
  status: "SUCCESS" | "FAILED";
  resultSummary: string;
}) {
  try {
    await recordAuditLog({
      actorId: input.user.id,
      action: "PAYSLIP_EMAIL",
      entityType: "PAYSLIP",
      entityId: input.payslip.id,
      meta: buildPaystubActionAuditMeta({
        actor: buildAuditActor(input.user),
        payslip: {
          id: input.payslip.id,
          employeeId: input.payslip.employeeId,
          payrollRunId: input.payslip.payrollRunId,
          employee: input.payslip.employee,
          payrollRun: input.payslip.payrollRun,
        },
        operation: "send_paystub_email",
        after: {
          delivery: "email",
          recipientEmail: input.recipientEmail,
          fileName: input.fileName,
          byteSize: input.byteSize,
        },
        status: input.status,
        resultSummary: input.resultSummary,
      }),
    });
  } catch {
    // best-effort
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const resolvedParams = await params;
  if (!resolvedParams?.id) {
    return NextResponse.json({ error: "Payslip id is required" }, { status: 400 });
  }

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

  const payload = await getPaystubDetailData(resolvedParams.id);
  if (!payload) {
    return NextResponse.json({ error: "Paystub not found" }, { status: 404 });
  }

  const { payslip, ytdTotals } = payload;
  const pdfBuffer = await buildPaystubPdf({ payslip, ytdTotals });
  const fileName = getPaystubPdfFileName(payslip.id);
  const periodLabel = formatPaystubDateRange(
    payslip.payrollRun.periodStart,
    payslip.payrollRun.periodEnd,
  );
  const currentRows = getPaystubCurrentBreakdownRows({
    grossPay: payslip.grossPay,
    netPay: payslip.netPay,
    lineItems: payslip.lineItems as Record<string, unknown> | null | undefined,
  });

  const subject = `Paystub for ${payslip.employee.firstName} ${payslip.employee.lastName}`;
  const text = [
    "Paystub details",
    `Employee: ${payslip.employee.firstName} ${payslip.employee.lastName}`,
    `Period: ${periodLabel}`,
    ...currentRows.slice(0, 4).map((row) => `${row.label}: ${formatPaystubMoney(row.value)}`),
  ].join("\n");

  const result = await sendEmail(parsed.data.email, subject, text, undefined, {
    attachments: [
      {
        filename: fileName,
        content: pdfBuffer,
        type: "application/pdf",
      },
    ],
  });

  if (!result.ok) {
    await recordPaystubEmailAudit({
      user,
      payslip,
      recipientEmail: parsed.data.email,
      fileName,
      byteSize: pdfBuffer.byteLength,
      status: "FAILED",
      resultSummary: `Paystub email to ${parsed.data.email} failed.`,
    });
    return NextResponse.json({ error: result.error || "Email failed" }, { status: 500 });
  }

  await recordPaystubEmailAudit({
    user,
    payslip,
    recipientEmail: parsed.data.email,
    fileName,
    byteSize: pdfBuffer.byteLength,
    status: "SUCCESS",
    resultSummary: `Paystub emailed to ${parsed.data.email} successfully.`,
  });

  return NextResponse.json({ ok: true });
}
