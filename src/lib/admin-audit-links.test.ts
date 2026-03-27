import test from "node:test";
import assert from "node:assert/strict";
import { appendAuditMetaParams, buildAdminAuditHref } from "@/lib/admin-audit-links";

test("buildAdminAuditHref encodes required query fields", () => {
  const href = buildAdminAuditHref({
    entityType: "EMPLOYEE",
    entityId: "emp 123",
    sourcePage: "/admin/hr/staff/emp 123",
  });
  assert.equal(
    href,
    "/admin/audit?entityType=EMPLOYEE&entityId=emp+123&sourcePage=%2Fadmin%2Fhr%2Fstaff%2Femp+123",
  );
});

test("appendAuditMetaParams appends audit metadata query", () => {
  const href = appendAuditMetaParams("/api/admin/hr/documents/doc-1/download", {
    sourcePage: "/admin/hr/staff/emp-1",
    section: "documents",
    operation: "download_document",
    resultSummary: "Employee document download started.",
  });
  assert.equal(
    href,
    "/api/admin/hr/documents/doc-1/download?sourcePage=%2Fadmin%2Fhr%2Fstaff%2Femp-1&section=documents&operation=download_document&resultSummary=Employee+document+download+started.",
  );
});
