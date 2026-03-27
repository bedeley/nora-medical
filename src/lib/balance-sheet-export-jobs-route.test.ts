import test from "node:test";
import assert from "node:assert/strict";
import {
  isBalanceSheetExportJobExpired,
  isBalanceSheetExportRoleAuthorized,
  parseFileNameFromContentDisposition,
  resolveBalanceSheetQueueGuardError,
} from "@/lib/balance-sheet-export-jobs-helpers";

test("balance-sheet export jobs route role authorization allows admin and accountant", () => {
  assert.equal(isBalanceSheetExportRoleAuthorized("ADMIN"), true);
  assert.equal(isBalanceSheetExportRoleAuthorized("ACCOUNTANT"), true);
  assert.equal(isBalanceSheetExportRoleAuthorized("STAFF"), false);
});

test("balance-sheet export jobs route guard errors include 403 and 429 cases", () => {
  const badOrigin = resolveBalanceSheetQueueGuardError({
    hasSession: true,
    sameOrigin: false,
    rateLimitOk: true,
  });
  assert.equal(badOrigin?.status, 403);
  const tooMany = resolveBalanceSheetQueueGuardError({
    hasSession: true,
    sameOrigin: true,
    rateLimitOk: false,
  });
  assert.equal(tooMany?.status, 429);
  const ok = resolveBalanceSheetQueueGuardError({
    hasSession: true,
    sameOrigin: true,
    rateLimitOk: true,
  });
  assert.equal(ok, null);
});

test("balance-sheet export job id route recognizes expiry edge cases", () => {
  assert.equal(isBalanceSheetExportJobExpired(Date.now() - 1, Date.now()), true);
  assert.equal(isBalanceSheetExportJobExpired(Number.NaN, Date.now()), true);
  assert.equal(isBalanceSheetExportJobExpired(Date.now() + 60_000, Date.now()), false);
});

test("balance-sheet export job id route parses file names from content disposition", () => {
  assert.equal(
    parseFileNameFromContentDisposition("attachment; filename=\"balance-sheet-2026-03-25.csv\""),
    "balance-sheet-2026-03-25.csv",
  );
  assert.equal(
    parseFileNameFromContentDisposition("attachment; filename=reporting-pack.csv"),
    "reporting-pack.csv",
  );
});
