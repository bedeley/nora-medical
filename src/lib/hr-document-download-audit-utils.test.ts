import test from "node:test";
import assert from "node:assert/strict";
import { resolveDocumentDownloadAuditMetaFromUrl } from "@/lib/hr-document-download-audit-utils";

test("document download audit meta parser uses defaults when query is missing", () => {
  const meta = resolveDocumentDownloadAuditMetaFromUrl(
    "https://example.com/api/admin/hr/documents/doc-1/download",
  );
  assert.equal(meta.sourcePage, "admin/hr/staff/[id]");
  assert.equal(meta.section, "documents");
  assert.equal(meta.operation, "download_document");
  assert.equal(meta.resultSummary, "Employee document download started.");
});

test("document download audit meta parser uses provided query overrides", () => {
  const meta = resolveDocumentDownloadAuditMetaFromUrl(
    "https://example.com/api/admin/hr/documents/doc-1/download?sourcePage=%2Fadmin%2Fhr%2Fstaff%2Femp-1&section=documents&operation=download_document&resultSummary=Started+from+staff+profile",
  );
  assert.equal(meta.sourcePage, "/admin/hr/staff/emp-1");
  assert.equal(meta.section, "documents");
  assert.equal(meta.operation, "download_document");
  assert.equal(meta.resultSummary, "Started from staff profile");
});
