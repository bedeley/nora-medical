import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());
const hrApiRoot = path.join(repoRoot, "src", "app", "api", "admin", "hr");

function getRouteFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getRouteFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name === "route.ts") files.push(full);
  }
  return files;
}

test("hr audit logging routes include essential metadata fields", () => {
  const routeFiles = getRouteFiles(hrApiRoot);
  const auditedFiles = routeFiles.filter((file) => fs.readFileSync(file, "utf8").includes("recordAuditLog("));
  assert.ok(auditedFiles.length > 0, "Expected at least one HR route using recordAuditLog.");

  for (const file of auditedFiles) {
    const source = fs.readFileSync(file, "utf8");
    const usesMetadataHelper =
      /buildPayrollRunExportAuditMeta\(/.test(source) ||
      /buildPayrollFilteredExportAuditMeta\(/.test(source);
    const hasInlineMetaObject = /meta:\s*{/.test(source);

    if (hasInlineMetaObject && !usesMetadataHelper) {
      assert.match(source, /sourcePage/, `${file} should include sourcePage in audit metadata.`);
      assert.match(source, /section/, `${file} should include section in audit metadata.`);
      assert.match(source, /operation/, `${file} should include operation in audit metadata.`);
      assert.match(source, /resultSummary/, `${file} should include resultSummary in audit metadata.`);
    }
    assert.match(source, /actorId/, `${file} should include actor identity for audit logs.`);
  }
});
