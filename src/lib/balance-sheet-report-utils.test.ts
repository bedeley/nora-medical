import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBalanceSheetExportAuditMeta,
  resolveBalanceSheetAsOf,
} from "@/lib/balance-sheet-report-utils";

test("balance-sheet endpoint rejects invalid asOf", () => {
  const parsed = resolveBalanceSheetAsOf("2026-99-01", "2026-03-25");
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.error, "As-of date is invalid. Use YYYY-MM-DD.");
  }
});

test("balance-sheet CSV and PDF export endpoints reject invalid asOf", () => {
  const csvParsed = resolveBalanceSheetAsOf("2026-02-31", "2026-03-25");
  assert.equal(csvParsed.ok, false);
  if (!csvParsed.ok) {
    assert.equal(csvParsed.error, "As-of date is invalid. Use YYYY-MM-DD.");
  }
  const pdfParsed = resolveBalanceSheetAsOf("not-a-date", "2026-03-25");
  assert.equal(pdfParsed.ok, false);
  if (!pdfParsed.ok) {
    assert.equal(pdfParsed.error, "As-of date is invalid. Use YYYY-MM-DD.");
  }
});

test("balance-sheet endpoint accepts valid asOf and default fallback", () => {
  const valid = resolveBalanceSheetAsOf("2026-03-15", "2026-03-25");
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.asOf, "2026-03-15");
  }

  const fallback = resolveBalanceSheetAsOf("", "2026-03-25");
  assert.equal(fallback.ok, true);
  if (fallback.ok) {
    assert.equal(fallback.asOf, "2026-03-25");
  }
});

test("balance-sheet export audit metadata includes required fields", () => {
  const meta = buildBalanceSheetExportAuditMeta({
    correlationId: "bs-corr-123",
    inputAsOf: "2026-03-20",
    effectiveAsOf: "2026-03-20",
    actorRole: "ADMIN",
    actorEmail: "admin@example.com",
    assetsRowCount: 3,
    liabilitiesRowCount: 2,
    equityRowCount: 2,
    totalRowCount: 7,
  });

  assert.equal(meta.sourcePage, "admin/accounting/reports/balance-sheet");
  assert.equal(meta.section, "exports");
  assert.equal(meta.operation, "export_csv");
  assert.equal(meta.correlationId, "bs-corr-123");
  assert.equal(meta.after.asOf, "2026-03-20");
  assert.equal(meta.totalRowCount, 7);
  assert.equal(typeof meta.before, "object");
  assert.equal(typeof meta.after, "object");
  assert.equal(meta.after.asOf, "2026-03-20");
});

test("balance-sheet export audit metadata supports PDF format", () => {
  const meta = buildBalanceSheetExportAuditMeta({
    correlationId: "bs-corr-456",
    inputAsOf: "2026-03-20",
    effectiveAsOf: "2026-03-20",
    actorRole: "ACCOUNTANT",
    actorEmail: "acct@example.com",
    assetsRowCount: 3,
    liabilitiesRowCount: 2,
    equityRowCount: 2,
    totalRowCount: 7,
    format: "pdf",
  });
  assert.equal(meta.operation, "export_pdf");
  assert.equal(meta.format, "pdf");
});
