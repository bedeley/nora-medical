import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("staff bulk status route enforces admin and same-origin guard", () => {
  const source = read("src/app/api/admin/hr/employees/bulk-status/route.ts");
  assert.match(source, /requireAdmin\(\)/);
  assert.match(source, /assertSameOrigin\(req\)/);
});

test("staff bulk status route records summary audit metadata", () => {
  const source = read("src/app/api/admin/hr/employees/bulk-status/route.ts");
  assert.match(source, /action:\s*"HR_EMPLOYEE_BULK_STATUS_UPDATE"/);
  assert.match(source, /sourcePage/);
  assert.match(source, /section/);
  assert.match(source, /operation/);
  assert.match(source, /before:\s*{/);
  assert.match(source, /after:\s*{/);
  assert.match(source, /successCount/);
  assert.match(source, /conflictCount/);
  assert.match(source, /failedCount/);
  assert.match(source, /resultSummary/);
});
