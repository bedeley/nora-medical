import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..", "..");
const auditPagePath = path.join(repoRoot, "src", "app", "(admin)", "admin", "audit", "page.tsx");

function readAuditPageSource() {
  return fs.readFileSync(auditPagePath, "utf8");
}

test("hr setting update audit rendering uses plain english labels", () => {
  const source = readAuditPageSource();
  assert.match(source, /HR_SETTING_UPDATE/);
  assert.match(source, /Setting:\s*<\/span>\s*\{settingLabel\}/);
  assert.match(source, /Operation:\s*<\/span>\s*\{operationLabel\}/);
  assert.match(source, /Updated review cadence/);
  assert.match(source, /Updated workweek days/);
});

test("hr setting update audit rendering includes before and after value snapshot", () => {
  const source = readAuditPageSource();
  assert.match(source, /hasValueSnapshot/);
  assert.match(source, /Changed value:/);
  assert.match(source, /Value:/);
  assert.match(source, /formatUnknownMetaValue\(beforeValue\)\}\s*\{"->"\}\s*\{formatUnknownMetaValue\(afterValue\)/);
});
