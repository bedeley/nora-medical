export type HrDocumentDownloadAuditMeta = {
  sourcePage: string;
  section: string;
  operation: string;
  resultSummary: string;
};

export function resolveDocumentDownloadAuditMetaFromUrl(url: string): HrDocumentDownloadAuditMeta {
  const searchParams = new URL(url).searchParams;
  return {
    sourcePage: searchParams.get("sourcePage")?.trim() || "admin/hr/staff/[id]",
    section: searchParams.get("section")?.trim() || "documents",
    operation: searchParams.get("operation")?.trim() || "download_document",
    resultSummary:
      searchParams.get("resultSummary")?.trim() || "Employee document download started.",
  };
}
