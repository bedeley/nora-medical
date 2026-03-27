import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { buildPaystubPdf, getPaystubDetailData } from "@/lib/hr-paystub-detail";
import {
  buildPaystubActionAuditMeta,
  getPaystubPdfFileName,
} from "@/lib/hr-paystub-utils";

export const runtime = "nodejs";

function buildAuditActor(user: AuthenticatedUser) {
  return {
    id: user.id,
    name: user.name || null,
    email: user.email || null,
    role: user.role,
  };
}

export async function GET(
  _req: Request,
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

  const payload = await getPaystubDetailData(resolvedParams.id);
  if (!payload) {
    return NextResponse.json({ error: "Paystub not found" }, { status: 404 });
  }

  const pdfBuffer = await buildPaystubPdf(payload);
  const fileName = getPaystubPdfFileName(payload.payslip.id);

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "PAYSLIP_PDF_DOWNLOAD",
      entityType: "PAYSLIP",
      entityId: payload.payslip.id,
      meta: buildPaystubActionAuditMeta({
        actor: buildAuditActor(user),
        payslip: {
          id: payload.payslip.id,
          employeeId: payload.payslip.employeeId,
          payrollRunId: payload.payslip.payrollRunId,
          employee: payload.payslip.employee,
          payrollRun: payload.payslip.payrollRun,
        },
        operation: "download_paystub_pdf",
        after: {
          delivery: "download",
          fileName,
          byteSize: pdfBuffer.byteLength,
          mimeType: "application/pdf",
        },
        resultSummary: "Paystub PDF downloaded successfully.",
      }),
    });
  } catch {
    // best-effort
  }

  return new Response(pdfBuffer, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Length": String(pdfBuffer.byteLength),
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}
