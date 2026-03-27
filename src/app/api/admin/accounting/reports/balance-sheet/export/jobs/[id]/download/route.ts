import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";
import { isBalanceSheetExportJobExpired, isBalanceSheetExportRoleAuthorized } from "@/lib/balance-sheet-export-jobs-helpers";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !isBalanceSheetExportRoleAuthorized(actor?.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const id = String(params.id || "").trim();
  if (!id) {
    return NextResponse.json({ error: "Job id is required." }, { status: 400 });
  }

  const key = `report.export.job.${id}`;
  const row = await prisma.siteSetting.findUnique({ where: { key } });
  if (!row) {
    return NextResponse.json({ error: "Export job not found or expired." }, { status: 404 });
  }
  const value = (row.value || {}) as Record<string, unknown>;
  const expiresAt = Number(value.expiresAt || 0);
  if (isBalanceSheetExportJobExpired(expiresAt, Date.now())) {
    await prisma.siteSetting.delete({ where: { key } }).catch(() => undefined);
    return NextResponse.json({ error: "Export job expired." }, { status: 404 });
  }

  const status = String(value.status || "").toUpperCase();
  if (status !== "READY") {
    return NextResponse.json({ error: "Export is not ready yet." }, { status: 409 });
  }
  const artifact = (value.artifact || null) as
    | {
        bytesBase64?: string;
        contentType?: string;
        fileName?: string;
        rowCount?: string | null;
        checksumSha256?: string | null;
        correlationId?: string | null;
      }
    | null;
  const bytesBase64 = String(artifact?.bytesBase64 || "");
  if (!bytesBase64) {
    return NextResponse.json({ error: "Export artifact is missing. Queue a new export job." }, { status: 404 });
  }
  const file = Buffer.from(bytesBase64, "base64");
  const contentType = String(artifact?.contentType || "application/octet-stream");
  const fileName = String(artifact?.fileName || `balance-sheet-export-${id}`);

  await recordAuditLog({
    actorId: actor?.id || null,
    action: "report.export.balance-sheet.job.download",
    entityType: "AccountingReportExportJob",
    entityId: id,
    meta: {
      sourcePage: "admin/accounting/reports/balance-sheet",
      section: "exports",
      operation: "download_queued_export",
      actorRole: actor?.role || null,
      actorEmail: actor?.email || null,
      fileName,
      contentType,
      byteSize: file.length,
      correlationId: artifact?.correlationId || null,
      integrity: {
        rowCount: artifact?.rowCount || null,
        checksumSha256: artifact?.checksumSha256 || null,
      },
    },
  });

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${fileName}"`,
  };
  if (artifact?.rowCount) headers["X-Export-Row-Count"] = artifact.rowCount;
  if (artifact?.checksumSha256) headers["X-Export-Checksum-Sha256"] = artifact.checksumSha256;
  if (artifact?.correlationId) headers["X-Report-Correlation-Id"] = artifact.correlationId;
  return new NextResponse(file, { headers });
}
