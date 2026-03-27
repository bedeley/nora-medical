import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("accounting settings audit links include sourcePage for scoped filtering", () => {
  const source = read("src/app/(admin)/admin/accounting/settings/page.tsx");
  assert.match(source, /scope=accounting_settings&sourcePage=admin\/accounting\/settings&settingSection=/);
  assert.match(source, /scope=accounting_settings&sourcePage=admin\/accounting\/settings/);
});

test("accounting periods audit link includes sourcePage", () => {
  const source = read("src/app/(admin)/admin/accounting/periods/page.tsx");
  assert.match(source, /scope=accounting_periods&sourcePage=admin\/accounting\/periods/);
});

test("balance sheet settings audit links use accounting_settings scope and sourcePage", () => {
  const source = read("src/app/(admin)/admin/accounting/reports/balance-sheet/page.tsx");
  assert.match(source, /scope=accounting_settings&action=app-setting\.update&sourcePage=admin\/accounting\/reports\/balance-sheet/);
});

test("journal archive audit link includes sourcePage", () => {
  const source = read("src/app/(admin)/admin/accounting/journal/page.tsx");
  assert.match(source, /\/admin\/audit\?entityType=JournalEntry&sourcePage=admin\/accounting\/journal/);
});

test("p&l selected export-job audit link includes sourcePage", () => {
  const source = read("src/app/(admin)/admin/accounting/reports/pl/page.tsx");
  assert.match(source, /scope=accounting_reports&action=report\.export\.job\.create&sourcePage=admin\/accounting\/reports\/pl&entityType=AccountingReportExportJob/);
});

