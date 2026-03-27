import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("hiring mutation routes enforce admin auth and same-origin checks", () => {
  const files = [
    "src/app/api/admin/hr/jobs/route.ts",
    "src/app/api/admin/hr/jobs/[id]/route.ts",
    "src/app/api/admin/hr/applicants/route.ts",
    "src/app/api/admin/hr/applicants/[id]/route.ts",
    "src/app/api/admin/hr/applications/route.ts",
    "src/app/api/admin/hr/applications/[id]/route.ts",
    "src/app/api/admin/hr/applications/bulk/route.ts",
  ];

  for (const file of files) {
    const source = read(file);
    assert.match(source, /Unauthorized/, `${file} should return Unauthorized for missing session.`);
    assert.match(source, /user\.role !== "ADMIN"/, `${file} should restrict mutations to ADMIN role.`);
    assert.match(source, /Bad origin/, `${file} should enforce same-origin guard on mutations.`);
  }
});

test("hiring update routes keep expectedUpdatedAt conflict checks", () => {
  const files = [
    "src/app/api/admin/hr/jobs/[id]/route.ts",
    "src/app/api/admin/hr/applicants/[id]/route.ts",
    "src/app/api/admin/hr/applications/[id]/route.ts",
    "src/app/api/admin/hr/applications/bulk/route.ts",
  ];

  for (const file of files) {
    const source = read(file);
    assert.match(
      source,
      /expectedUpdatedAt/i,
      `${file} should include expectedUpdatedAt conflict-safe update handling.`,
    );
  }
});

