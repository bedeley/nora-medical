import { execFileSync } from "node:child_process";

function quote(arg) {
  if (!/[\s"]/u.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function git(args) {
  if (process.platform === "win32") {
    return execFileSync(
      "cmd.exe",
      ["/d", "/s", "/c", `git ${args.map(quote).join(" ")}`],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  }

  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function safeGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

const repoRoot = safeGit(["rev-parse", "--show-toplevel"]);

if (!repoRoot) {
  console.log("Skipping Prisma migration immutability check outside a git repository.");
  process.exit(0);
}

const headCommit = safeGit(["rev-parse", "--verify", "HEAD"]);

if (!headCommit) {
  console.log("Skipping Prisma migration immutability check because HEAD does not exist yet.");
  process.exit(0);
}

const headFiles = git(["ls-tree", "-r", "--name-only", "HEAD", "--", "prisma/migrations"])
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter(Boolean)
  .filter((value) => value.endsWith("/migration.sql"));

const trackedMigrationFiles = new Set(headFiles);

const changedFiles = git(["diff", "--name-only", "HEAD", "--", "prisma/migrations"])
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter(Boolean)
  .filter((value) => value.endsWith("/migration.sql"));

const changedTrackedMigrations = changedFiles.filter((value) =>
  trackedMigrationFiles.has(value),
);

if (changedTrackedMigrations.length === 0) {
  console.log("Prisma migration history check passed.");
  process.exit(0);
}

console.error("Refusing to proceed because an existing Prisma migration was edited:");
for (const file of changedTrackedMigrations) {
  console.error(` - ${file}`);
}
console.error("");
console.error("Prisma stores a checksum for each applied migration.");
console.error("Editing an existing migration later can force `prisma migrate dev` to request a schema reset.");
console.error("Create a new migration instead, or restore the original file from git.");
process.exit(1);
