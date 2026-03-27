import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("staff import route supports dryRun flag in payload", () => {
  const source = read("src/app/api/admin/hr/employees/import/route.ts");
  assert.match(source, /dryRun:\s*z\.boolean\(\)\.optional\(\)/);
  assert.match(source, /const dryRun = Boolean\(parsed\.data\.dryRun\)/);
});

test("staff import route returns preview summary for dry runs", () => {
  const source = read("src/app/api/admin/hr/employees/import/route.ts");
  assert.match(source, /preview_employee_import_csv/);
  assert.match(source, /would create/);
  assert.match(source, /resultSummary/);
  assert.match(source, /dryRun/);
});
