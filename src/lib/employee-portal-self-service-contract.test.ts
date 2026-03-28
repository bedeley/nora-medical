import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("employee portal page exposes leave self-service entry points", () => {
  const source = read("src/app/(shop)/account/employee/page.tsx");
  assert.match(source, /EmployeeLeaveSection/);
  assert.match(source, /EmployeePortalExpandableItems/);
  assert.match(source, /href="#pay-and-documents"/);
  assert.match(source, /href="#leave-and-onboarding"/);
});

test("employee portal leave routes record employee self-service audit metadata", () => {
  const createRoute = read("src/app/api/account/employee/leave/route.ts");
  const cancelRoute = read("src/app/api/account/employee/leave/[id]/route.ts");
  assert.match(createRoute, /section:\s*"employee-portal-leave"/);
  assert.match(createRoute, /operation:\s*"request_leave"/);
  assert.match(cancelRoute, /section:\s*"employee-portal-leave"/);
  assert.match(cancelRoute, /operation:\s*"cancel_leave_request"/);
});

test("employee portal exposes acknowledgements, previews, and contact update requests", () => {
  const source = read("src/app/(shop)/account/employee/page.tsx");
  const docAckRoute = read("src/app/api/account/employee/documents/[id]/acknowledge/route.ts");
  const reviewAckRoute = read("src/app/api/account/employee/reviews/[id]/acknowledge/route.ts");
  const contactRequestRoute = read("src/app/api/account/employee/profile-update-request/route.ts");
  const previewRoute = read("src/app/api/account/employee/documents/[id]/preview/route.ts");

  assert.match(source, /EmployeeContactUpdateRequestCard/);
  assert.match(source, /EmployeePortalAcknowledgeButton/);
  assert.match(source, /View all documents/);
  assert.match(docAckRoute, /operation:\s*"acknowledge_document"/);
  assert.match(reviewAckRoute, /operation:\s*"acknowledge_review_summary"/);
  assert.match(contactRequestRoute, /operation:\s*"request_contact_update"/);
  assert.match(previewRoute, /operation:\s*"preview_document"/);
});
