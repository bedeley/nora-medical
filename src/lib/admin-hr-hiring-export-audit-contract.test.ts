import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("hiring export routes include essential export audit metadata", () => {
  const files = [
    "src/app/api/admin/hr/hiring/export/applicants/route.ts",
    "src/app/api/admin/hr/hiring/export/jobs/route.ts",
    "src/app/api/admin/hr/hiring/export/applications/route.ts",
  ];

  for (const file of files) {
    const source = read(file);
    assert.match(source, /fileName/, `${file} should include fileName in audit metadata.`);
    assert.match(source, /format/, `${file} should include format in audit metadata.`);
    assert.match(source, /rowCount/, `${file} should include rowCount in audit metadata.`);
    assert.match(source, /columnCount/, `${file} should include columnCount in audit metadata.`);
    assert.match(source, /byteSize/, `${file} should include byteSize in audit metadata.`);
    assert.match(source, /scopeSnapshot/, `${file} should include scopeSnapshot in audit metadata.`);
    assert.match(source, /resultSummary/, `${file} should include resultSummary in audit metadata.`);
  }
});

