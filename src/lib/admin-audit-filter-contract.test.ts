import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());
const auditPagePath = path.join(
  repoRoot,
  "src",
  "app",
  "(admin)",
  "admin",
  "audit",
  "page.tsx",
);

function readAuditPageSource(): string {
  return fs.readFileSync(auditPagePath, "utf8");
}

test("audit filter contract keeps sourcePage in query and state lifecycle", () => {
  const source = readAuditPageSource();

  assert.match(source, /const\s+\[sourcePage,\s*setSourcePage\]\s*=\s*useState\(""\)/);
  assert.match(source, /if\s*\(sourcePage\)\s*params\.set\("sourcePage",\s*sourcePage\)/);
  assert.match(source, /setSourcePage\(""\)/, "clearFilters should clear sourcePage");
  assert.match(source, /buildCurrentFilterState\s*=\s*\(\)\s*=>\s*\(\{[\s\S]*sourcePage,/);
  assert.match(source, /setSourcePage\(normalizeSourcePage\(s\.sourcePage\s*\|\|\s*""\)\)/);
});

test("audit filter contract keeps payrollRunId in query and saved-filter lifecycle", () => {
  const source = readAuditPageSource();

  assert.match(source, /const\s+\[payrollRunId,\s*setPayrollRunId\]\s*=\s*useState\(""\)/);
  assert.match(source, /if\s*\(payrollRunId\)\s*params\.set\("payrollRunId",\s*payrollRunId\)/);
  assert.match(source, /setPayrollRunId\(""\)/, "clearFilters should clear payrollRunId");
  assert.match(source, /buildCurrentFilterState\s*=\s*\(\)\s*=>\s*\(\{[\s\S]*payrollRunId,/);
  assert.match(source, /setPayrollRunId\(s\.payrollRunId\s*\|\|\s*""\)/);
});

test("audit filter UI exposes source page selector", () => {
  const source = readAuditPageSource();
  assert.match(source, /label className="text-xs text-muted-foreground">Source page<\/label>/);
  assert.match(source, /HR_SOURCE_PAGE_OPTIONS\.map/);
  assert.match(source, /admin\/orders/);
  assert.match(source, /admin\/users/);
  assert.match(source, /admin\/health\/incidents/);
});
