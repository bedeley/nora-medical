import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("staff views route enforces admin and same-origin guards", () => {
  const source = read("src/app/api/admin/hr/employees/views/route.ts");
  assert.match(source, /requireAdmin\(\)/);
  assert.match(source, /assertSameOrigin\(req\)/);
});

test("staff views route exposes GET POST DELETE handlers and response shapes", () => {
  const source = read("src/app/api/admin/hr/employees/views/route.ts");
  assert.match(source, /export async function GET/);
  assert.match(source, /export async function POST/);
  assert.match(source, /export async function DELETE/);
  assert.match(source, /return NextResponse\.json\(\{ items, updatedAt:/);
  assert.match(source, /return NextResponse\.json\(\{ item: nextItem, items: next \}\)/);
  assert.match(source, /return NextResponse\.json\(\{ ok: true, items: next \}\)/);
});

test("staff views route audit metadata includes essential fields", () => {
  const source = read("src/app/api/admin/hr/employees/views/route.ts");
  assert.match(source, /action:\s*"HR_STAFF_VIEW_SAVE"/);
  assert.match(source, /action:\s*"HR_STAFF_VIEW_DELETE"/);
  assert.match(source, /sourcePage:\s*"admin\/hr\/staff"/);
  assert.match(source, /section:\s*"saved-views"/);
  assert.match(source, /operation:\s*"save_staff_view"/);
  assert.match(source, /operation:\s*"delete_staff_view"/);
  assert.match(source, /before:/);
  assert.match(source, /after:/);
  assert.match(source, /resultSummary/);
});
