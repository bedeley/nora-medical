import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());

function read(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("review routes expose per-review employee portal visibility controls", () => {
  const listRoute = read("src/app/api/admin/hr/reviews/route.ts");
  const updateRoute = read("src/app/api/admin/hr/reviews/[id]/route.ts");
  const bulkRoute = read("src/app/api/admin/hr/reviews/bulk-workflow/route.ts");

  assert.match(listRoute, /workflowEmployeeVisible/);
  assert.match(updateRoute, /employeeVisible:\s*z\.boolean\(\)\.optional\(\)/);
  assert.match(updateRoute, /show_review_in_employee_portal/);
  assert.match(updateRoute, /hide_review_from_employee_portal/);
  assert.match(bulkRoute, /SHOW_IN_PORTAL/);
  assert.match(bulkRoute, /HIDE_FROM_PORTAL/);
});

test("employee portal filters reviews by per-review visibility", () => {
  const source = read("src/lib/employee-portal.ts");
  assert.match(source, /workflowEmployeeVisible/);
  assert.match(source, /review\.workflowEmployeeVisible/);
});
