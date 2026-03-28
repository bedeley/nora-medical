import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..", "..");
const usersRoutePath = path.join(repoRoot, "src", "app", "api", "admin", "users", "route.ts");

function readSource(filePath: string) {
  return fs.readFileSync(filePath, "utf8");
}

test("admin user create route supports explicit employee linking metadata", () => {
  const source = readSource(usersRoutePath);
  assert.match(source, /employeeId: z\.string\(\)\.optional\(\)\.or\(z\.literal\(""\)\)/);
  assert.match(source, /sourcePage: z\.string\(\)\.optional\(\)\.or\(z\.literal\(""\)\)/);
  assert.match(source, /section: z\.string\(\)\.optional\(\)\.or\(z\.literal\(""\)\)/);
  assert.match(source, /operation: z\.string\(\)\.optional\(\)\.or\(z\.literal\(""\)\)/);
  assert.match(source, /targetEmployee = employeeId/);
  assert.match(source, /Employee already has a linked user account\./);
  assert.match(source, /await tx\.employee\.update\(/);
  assert.match(source, /employeeId: targetEmployee\?\.id \?\? null/);
});
