import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";
import {
  isBalanceSheetExportJobExpired,
  isBalanceSheetExportRoleAuthorized,
  parseFileNameFromContentDisposition,
} from "@/lib/balance-sheet-export-jobs-helpers";

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
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
  const asOf = String(value.asOf || "").trim() || null;
  const expiresAt = Number(value.expiresAt || 0);
  if (isBalanceSheetExportJobExpired(expiresAt, Date.now())) {
    await prisma.siteSetting.delete({ where: { key } }).catch(() => undefined);
    return NextResponse.json({ error: "Export job expired." }, { status: 404 });
  }

  let status = String(value.status || "QUEUED").toUpperCase();
  const downloadUrl = String(value.downloadUrl || "");
  const requestUrl = String(value.requestUrl || "");
  let failReason = value.failReason ? String(value.failReason) : null;
  let artifact = (value.artifact || null) as
    | {
        bytesBase64?: string;
        contentType?: string;
        fileName?: string;
        byteSize?: number;
        rowCount?: string | null;
        checksumSha256?: string | null;
        correlationId?: string | null;
      }
    | null;
  if (!downloadUrl && status !== "FAILED") {
    status = "FAILED";
    failReason = "Export file link is missing. Queue a new export job.";
  }
  if (status !== "READY" && status !== "FAILED" && status !== "QUEUED") {
    status = "QUEUED";
  }
  if (status === "QUEUED") {
    if (!requestUrl) {
      status = "FAILED";
      failReason = "Export request URL is missing. Queue a new export job.";
    } else {
      try {
        const upstreamUrl = new URL(requestUrl, new URL(req.url).origin);
        const upstreamResponse = await fetch(upstreamUrl, {
          headers: {
            cookie: req.headers.get("cookie") || "",
          },
          cache: "no-store",
        });
        if (!upstreamResponse.ok) {
          const payload = (await upstreamResponse.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error || `Export generation failed (${upstreamResponse.status}).`);
        }
        const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
        if (buffer.length > MAX_ARTIFACT_BYTES) {
          throw new Error("Generated export is too large to cache as a queued artifact.");
        }
        const contentType = String(upstreamResponse.headers.get("Content-Type") || "application/octet-stream");
        const fileName =
          parseFileNameFromContentDisposition(upstreamResponse.headers.get("Content-Disposition")) ||
          `balance-sheet-export-${id}`;
        artifact = {
          bytesBase64: buffer.toString("base64"),
          contentType,
          fileName,
          byteSize: buffer.length,
          rowCount: upstreamResponse.headers.get("X-Export-Row-Count"),
          checksumSha256: upstreamResponse.headers.get("X-Export-Checksum-Sha256"),
          correlationId: upstreamResponse.headers.get("X-Report-Correlation-Id"),
        };
        status = "READY";
        failReason = null;
        await recordAuditLog({
          actorId: actor?.id || null,
          action: "report.export.balance-sheet.job.materialize",
          entityType: "AccountingReportExportJob",
          entityId: id,
          meta: {
            sourcePage: "admin/accounting/reports/balance-sheet",
            section: "exports",
            operation: "materialize_queued_export",
            actorRole: actor?.role || null,
            actorEmail: actor?.email || null,
            before: { status: "QUEUED", asOf },
            after: { status: "READY", asOf },
            contentType,
            fileName,
            format: String(contentType || "").toLowerCase().includes("pdf") ? "pdf" : "csv",
            byteSize: buffer.length,
            rowCount: Number(artifact.rowCount || 0) || null,
            correlationId: artifact.correlationId || null,
            scopeSnapshot: asOf ? `As of ${asOf}` : null,
            resultSummary: "Queued export materialized and ready to download.",
            integrity: {
              rowCount: artifact.rowCount || null,
              checksumSha256: artifact.checksumSha256 || null,
            },
          },
        });
      } catch (error) {
        status = "FAILED";
        failReason = error instanceof Error ? error.message : "Failed to generate export artifact.";
        await recordAuditLog({
          actorId: actor?.id || null,
          action: "report.export.balance-sheet.job.materialize.failed",
          entityType: "AccountingReportExportJob",
          entityId: id,
          meta: {
            sourcePage: "admin/accounting/reports/balance-sheet",
            section: "exports",
            operation: "materialize_queued_export",
            actorRole: actor?.role || null,
            actorEmail: actor?.email || null,
            before: { status: "QUEUED", asOf },
            after: { status: "FAILED", asOf },
            scopeSnapshot: asOf ? `As of ${asOf}` : null,
            resultSummary: "Queued export materialization failed.",
            failReason,
          },
        });
      }
    }
  }
  await prisma.siteSetting.update({
    where: { key },
    data: {
      value: {
        ...(value as Record<string, unknown>),
        status,
        failReason,
        artifact,
      } as Prisma.InputJsonValue,
    },
  });

  return NextResponse.json({
    jobId: id,
    status,
    downloadUrl,
    expiresAt,
    failReason,
  });
}
