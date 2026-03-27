import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());
const adminAppRoot = path.join(repoRoot, "src", "app", "(admin)", "admin");

function collectTsxFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsxFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".tsx")) files.push(full);
  }
  return files;
}

test("admin audit deep-links include sourcePage for clear-filter parity", () => {
  const files = collectTsxFiles(adminAppRoot).filter(
    (file) => !file.endsWith(path.join("admin", "audit", "page.tsx")),
  );
  const missing: Array<{ file: string; href: string }> = [];
  const hrefPattern = /(?<!\/api)\/admin\/audit\?[^"'`]*/g;

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const matches = source.match(hrefPattern) || [];
    for (const href of matches) {
      if (!href.includes("sourcePage=")) {
        missing.push({
          file: path.relative(repoRoot, file).replace(/\\/g, "/"),
          href,
        });
      }
    }
  }

  assert.equal(
    missing.length,
    0,
    `Missing sourcePage in /admin/audit links:\n${missing
      .map((item) => `- ${item.file}: ${item.href}`)
      .join("\n")}`,
  );
});
