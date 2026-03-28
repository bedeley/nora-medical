import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("hr jobs route returns total alongside rows for dashboard summaries", () => {
  const source = read("src/app/api/admin/hr/jobs/route.ts");

  assert.match(source, /prisma\.jobPosting\.count\(\{ where \}\)/, "jobs route should calculate a total count.");
  assert.match(source, /return NextResponse\.json\(\{ rows: jobs, total \}\)/, "jobs route should return rows and total.");
});

test("hr summary route exposes attention and portal oversight fields", () => {
  const source = read("src/app/api/admin/hr/summary/route.ts");

  assert.match(source, /pendingLeaveRequests/, "HR summary route should include pending leave requests.");
  assert.match(source, /latestRun/, "HR summary route should include the latest payroll run.");
  assert.match(source, /visiblePortalDocuments/, "HR summary route should include portal-visible document count.");
  assert.match(source, /visibleReviewSummaries/, "HR summary route should include portal-visible review counts.");
  assert.match(source, /linkedEmployees/, "HR summary route should include linked employee count.");
  assert.match(source, /recentActivity/, "HR summary route should include recent activity.");
  assert.match(source, /auditLog\.findMany/, "HR summary route should load recent audit rows.");
});

test("hr landing page uses summary totals and shows visible load failures", () => {
  const source = read("src/app/(admin)/admin/hr/page.tsx");

  assert.match(source, /fetcher\("\/api\/admin\/hr\/summary"\)/, "HR hub should use the dedicated summary route.");
  assert.match(source, /employeeSummary\?\.total/, "HR hub should use the employee summary total.");
  assert.match(source, /hiringSummary\?\.openRoles/, "HR hub should use the hiring summary total.");
  assert.match(source, /issuesSummary\?\.open/, "HR hub should use the issues summary total.");
  assert.match(source, /Some HR summary data could not be loaded/, "HR hub should show a visible failed-load state.");
  assert.match(source, /Retry failed loads/, "HR hub should let admins retry failed summary requests.");
  assert.match(source, /Open Compensation/, "Compensation card label should match its destination.");
  assert.match(source, /HR workspace/, "HR hub should present a workspace hero.");
  assert.match(source, /People operations/, "HR hub should group people work into its own section.");
  assert.match(source, /Payroll and performance/, "HR hub should group payroll work into its own section.");
  assert.match(source, /Reporting and exports/, "HR hub should move exports into a dedicated reporting section.");
  assert.match(source, /Attention needed/, "HR hub should show an attention summary section.");
  assert.match(source, /Employee portal oversight/, "HR hub should show employee portal oversight.");
  assert.match(source, /Quick actions/, "HR hub should expose quick operational shortcuts.");
  assert.match(source, /Recent HR activity/, "HR hub should show a recent HR activity strip.");
  assert.match(source, /Add employee/, "HR hub should expose an add employee action.");
  assert.match(source, /Create payroll run/, "HR hub should expose a create payroll run action.");
  assert.match(source, /Open HR audit/, "HR hub should link to scoped HR audit activity.");
});
