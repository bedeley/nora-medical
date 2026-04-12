import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("hr issues audit links include sourcePage", () => {
  const source = read("src/app/(admin)/admin/hr/issues/page.tsx");
  assert.match(source, /\/admin\/audit\?entityType=STAFF_ISSUE&sourcePage=admin\/hr\/issues/);
  assert.match(source, /entityType=STAFF_ISSUE&entityId=\$\{encodeURIComponent\(issue\.id\)\}&sourcePage=admin\/hr\/issues/);
});

test("hr reviews audit links include sourcePage", () => {
  const source = read("src/app/(admin)/admin/hr/reviews/ReviewsClient.tsx");
  assert.match(source, /entityType=PERFORMANCE_REVIEW&entityId=\$\{encodeURIComponent\(review\.id\)\}&sourcePage=admin\/hr\/reviews/);
  assert.match(source, /\/admin\/audit\?entityType=PERFORMANCE_REVIEW&sourcePage=admin\/hr\/reviews/);
});

test("hr staff audit links include sourcePage", () => {
  const source = read("src/app/(admin)/admin/hr/staff/page.tsx");
  assert.match(source, /pathname:\s*"\/admin\/audit"/);
  assert.match(source, /sourcePage:\s*STAFF_SOURCE_PAGE/);
  assert.match(source, /entityType:\s*"EMPLOYEE"/);
});

test("order pages audit links include sourcePage", () => {
  const listPage = read("src/app/(admin)/admin/orders/page.tsx");
  const detailPage = read("src/app/(admin)/admin/orders/[id]/OrderDetails.tsx");
  const otcPage = read("src/app/(admin)/admin/orders/otc/page.tsx");
  assert.match(listPage, /const isAdmin = role === "ADMIN"/);
  assert.match(listPage, /entityType=ORDER&entityId=\$\{order\.id\}&sourcePage=admin\/orders/);
  assert.match(listPage, /entityType=ORDER&sourcePage=admin\/orders/);
  assert.match(detailPage, /role === "ADMIN"/);
  assert.match(detailPage, /buildAdminAuditHref/);
  assert.match(detailPage, /sourcePage:\s*"admin\/orders\/\[id\]"/);
  assert.match(otcPage, /entityType=ORDER&entityId=\$\{completedOrderId\}&sourcePage=admin\/orders\/otc/);
});

test("operations and admin pages audit links include sourcePage", () => {
  const shiftClose = read("src/app/(admin)/admin/otc/shift-close/page.tsx");
  const users = read("src/app/(admin)/admin/users/page.tsx");
  const customerView = read("src/app/(admin)/admin/customers/[id]/view/page.tsx");
  const healthIncidents = read("src/app/(admin)/admin/health/incidents/page.tsx");
  assert.match(shiftClose, /action=OTC_SHIFT_CLOSE&entityType=OTC_SHIFT&entityId=\$\{encodeURIComponent\(row\.shiftCloseId\)\}&sourcePage=admin\/otc\/shift-close/);
  assert.match(users, /\/admin\/audit\?entityType=USER&sourcePage=admin\/users/);
  assert.match(users, /entityType=USER&entityId=\$\{user\.id\}&sourcePage=admin\/users/);
  assert.match(customerView, /\/admin\/audit\?customerId=\$\{encodeURIComponent\(/);
  assert.match(customerView, /&sourcePage=admin\/customers\/\[id\]\/view/);
  assert.match(healthIncidents, /\/admin\/audit\?sourcePage=admin\/health\/incidents/);
});

test("users page exposes HR profile repair actions", () => {
  const users = read("src/app/(admin)/admin/users/page.tsx");
  assert.match(users, /Create HR profile/);
  assert.match(users, /Fix HR link/);
  assert.match(users, /\/api\/admin\/users\/\$\{userId\}\/employee-profile/);
});
