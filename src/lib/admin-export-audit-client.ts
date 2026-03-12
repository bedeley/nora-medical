export type AdminExportAuditPayload = {
  area: string;
  format: "CSV" | "PDF";
  fileName: string;
  scopeSnapshot?: string;
  rowCount?: number;
  columnCount?: number;
  byteSize?: number;
};

export async function logAdminExportDownload(payload: AdminExportAuditPayload) {
  try {
    await fetch("/api/admin/audit/export-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Best effort only; never block download.
  }
}
