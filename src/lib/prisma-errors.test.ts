import assert from "node:assert/strict";
import test from "node:test";
import { isPrismaRecordNotFoundError, isPrismaUniqueConstraintError } from "@/lib/prisma-errors";

test("isPrismaUniqueConstraintError identifies P2002", () => {
  assert.equal(isPrismaUniqueConstraintError({ code: "P2002" }), true);
  assert.equal(isPrismaUniqueConstraintError({ code: "P2025" }), false);
  assert.equal(isPrismaUniqueConstraintError(new Error("x")), false);
});

test("isPrismaRecordNotFoundError identifies P2025", () => {
  assert.equal(isPrismaRecordNotFoundError({ code: "P2025" }), true);
  assert.equal(isPrismaRecordNotFoundError({ code: "P2002" }), false);
  assert.equal(isPrismaRecordNotFoundError(null), false);
});
