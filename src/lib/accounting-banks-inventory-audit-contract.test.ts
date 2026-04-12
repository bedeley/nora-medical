import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = process.cwd();

function readRepoFile(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("accounting bank routes use structured audit logging with request-aware metadata", () => {
  const files = [
    "src/app/api/admin/accounting/banks/route.ts",
    "src/app/api/admin/accounting/banks/[id]/route.ts",
    "src/app/api/admin/accounting/banks/[id]/transactions/route.ts",
    "src/app/api/admin/accounting/banks/[id]/transactions/[txnId]/route.ts",
    "src/app/api/admin/accounting/banks/[id]/transactions/bulk/route.ts",
    "src/app/api/admin/accounting/banks/[id]/rules/route.ts",
    "src/app/api/admin/accounting/banks/[id]/rules/[ruleId]/route.ts",
    "src/app/api/admin/accounting/banks/[id]/rules/import/route.ts",
    "src/app/api/admin/accounting/banks/[id]/rules/export/route.ts",
  ];

  for (const file of files) {
    const source = readRepoFile(file);
    assert.match(source, /recordAccountingBankAudit\(/, `${file} should use structured bank audit logging.`);
  }
});

test("accounting bank page export actions include audit client logging and scoped export params", () => {
  const source = readRepoFile("src/app/(admin)/admin/accounting/banks/page.tsx");
  assert.match(source, /logAdminExportDownload\(/, "banks page should log client-side exports.");
  assert.match(source, /accounting-bank-transactions-selected/, "selected transaction export should have a dedicated audit area.");
  assert.match(source, /accounting-bank-import-run-issues/, "issues CSV export should have a dedicated audit area.");
  assert.match(source, /sourcePage", "admin\/accounting\/banks"|sourcePage: "admin\/accounting\/banks"/, "banks exports should include sourcePage.");
  assert.match(source, /params\.set\("sourcePage", "admin\/accounting\/banks"\)/, "server CSV exports should carry sourcePage.");
  assert.match(source, /rules\/export\?sourcePage=admin%2Faccounting%2Fbanks/, "rules export link should include scoped sourcePage metadata.");
});

test("inventory lot trace and adjustment routes include audit metadata for traceability", () => {
  const detailSource = readRepoFile("src/app/api/admin/inventory/lots/[id]/route.ts");
  const adjustSource = readRepoFile("src/app/api/admin/inventory/lots/[id]/adjust/route.ts");
  assert.match(detailSource, /INVENTORY_LOT_TRACE_VIEWED/, "lot trace route should record trace view audit events.");
  assert.match(detailSource, /sourcePage: "admin\/inventory-lots"/, "lot trace route should include sourcePage metadata.");
  assert.match(adjustSource, /sourcePage: "admin\/inventory-lots"/, "lot adjustment route should include sourcePage metadata.");
  assert.match(adjustSource, /operation: "adjust_remaining_quantity"/, "lot adjustment route should describe the audited operation.");
});

test("inventory lots trace exports include richer audit metadata", () => {
  const source = readRepoFile("src/app/(admin)/admin/inventory-lots/page.tsx");
  assert.match(source, /inventory-lots-trace-summary/, "trace summary export should remain audited.");
  assert.match(source, /inventory-lots-trace-combined/, "combined trace export should remain audited.");
  assert.match(source, /inventory-lots-trace-movements/, "movement trace export should remain audited.");
  assert.match(source, /sourcePage: "admin\/inventory-lots"/, "trace export audit payloads should include sourcePage.");
  assert.match(source, /resultSummary:/, "trace export audit payloads should include result summaries.");
});
