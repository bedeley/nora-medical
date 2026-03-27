import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTrialBalanceExportAuditMeta,
  resolveTrialBalanceDateRange,
} from "@/lib/trial-balance-report-utils";

test("trial-balance endpoints reject invalid date inputs", () => {
  const invalidStart = resolveTrialBalanceDateRange("2026-13-01", "2026-03-25");
  assert.equal(invalidStart.ok, false);
  if (!invalidStart.ok) {
    assert.equal(invalidStart.error, "Start date is invalid. Use YYYY-MM-DD.");
  }

  const invalidEnd = resolveTrialBalanceDateRange("2026-03-01", "2026-02-30");
  assert.equal(invalidEnd.ok, false);
  if (!invalidEnd.ok) {
    assert.equal(invalidEnd.error, "End date is invalid. Use YYYY-MM-DD.");
  }

  const invertedRange = resolveTrialBalanceDateRange("2026-03-31", "2026-03-01");
  assert.equal(invertedRange.ok, false);
  if (!invertedRange.ok) {
    assert.equal(invertedRange.error, "End date cannot be earlier than start date.");
  }
});

test("trial-balance endpoints accept valid date range and blank filters", () => {
  const valid = resolveTrialBalanceDateRange("2026-03-01", "2026-03-31");
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.start, "2026-03-01");
    assert.equal(valid.end, "2026-03-31");
  }

  const blank = resolveTrialBalanceDateRange("", "");
  assert.equal(blank.ok, true);
  if (blank.ok) {
    assert.equal(blank.start, null);
    assert.equal(blank.end, null);
  }
});

test("trial-balance export audit metadata includes required fields", () => {
  const meta = buildTrialBalanceExportAuditMeta({
    correlationId: "tb-corr-123",
    includeZero: true,
    inputStart: "2026-03-01",
    inputEnd: "2026-03-31",
    effectiveStart: "2026-03-01",
    effectiveEnd: "2026-03-31",
    actorRole: "ACCOUNTANT",
    actorEmail: "acct@example.com",
    rowCount: 20,
    integrityRowCount: 21,
    checksumSha256: "abc123",
    fileName: "trial-balance-2026-03-01-2026-03-31.csv",
    columnCount: 9,
    byteSize: 1024,
  });

  assert.equal(meta.sourcePage, "admin/accounting/reports/trial-balance");
  assert.equal(meta.section, "trial-balance");
  assert.equal(meta.operation, "export_csv");
  assert.equal(meta.correlationId, "tb-corr-123");
  assert.equal(meta.includeZero, true);
  assert.equal(meta.before.start, "2026-03-01");
  assert.equal(meta.after.end, "2026-03-31");
  assert.equal(meta.rowCount, 20);
  assert.equal(meta.columnCount, 9);
  assert.equal(meta.byteSize, 1024);
  assert.equal(meta.fileName, "trial-balance-2026-03-01-2026-03-31.csv");
  assert.equal(meta.integrity.rowCount, 21);
  assert.equal(meta.integrity.checksumSha256, "abc123");
  assert.equal(meta.status, "SUCCESS");
});
