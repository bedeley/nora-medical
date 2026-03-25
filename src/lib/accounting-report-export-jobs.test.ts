import test from "node:test";
import assert from "node:assert/strict";
import {
  collectExpiredJobKeys,
  collectOverflowJobKeys,
  getJobCreatedAt,
  getJobExpiresAt,
  normalizeFailureSimulationInput,
} from "./accounting-report-export-jobs";

test("getJobExpiresAt returns finite timestamp", () => {
  assert.equal(getJobExpiresAt({ expiresAt: 1234 }), 1234);
  assert.equal(getJobExpiresAt({ expiresAt: "1234" }), 1234);
  assert.equal(getJobExpiresAt({ expiresAt: "bad" }), null);
});

test("getJobCreatedAt falls back when missing", () => {
  assert.equal(getJobCreatedAt({ createdAt: 100 }), 100);
  assert.equal(getJobCreatedAt({}, 55), 55);
  assert.equal(getJobCreatedAt({ createdAt: "bad" }, 77), 0);
});

test("collectExpiredJobKeys returns only expired keys", () => {
  const now = 500;
  const keys = collectExpiredJobKeys(
    [
      { key: "a", value: { expiresAt: 200 } },
      { key: "b", value: { expiresAt: 500 } },
      { key: "c", value: { expiresAt: 700 } },
      { key: "d", value: { expiresAt: "bad" } },
    ],
    now,
  );
  assert.deepEqual(keys, ["a", "b"]);
});

test("collectOverflowJobKeys keeps newest active jobs only", () => {
  const now = 1_000;
  const keys = collectOverflowJobKeys(
    [
      { key: "j1", value: { createdAt: 400, expiresAt: 2_000 } },
      { key: "j2", value: { createdAt: 500, expiresAt: 2_000 } },
      { key: "j3", value: { createdAt: 300, expiresAt: 2_000 } },
      { key: "expired", value: { createdAt: 600, expiresAt: 900 } },
    ],
    now,
    2,
  );
  assert.deepEqual(keys, ["j3"]);
});

test("normalizeFailureSimulationInput validates action and reason", () => {
  const invalid = normalizeFailureSimulationInput({ action: "x" });
  assert.equal(invalid.ok, false);

  const validDefault = normalizeFailureSimulationInput({ action: "simulate_failure" });
  assert.equal(validDefault.ok, true);
  if (validDefault.ok) {
    assert.equal(validDefault.failReason, "Simulated failure for testing.");
  }

  const validCustom = normalizeFailureSimulationInput({ action: "simulate_failure", failReason: "  timeout  " });
  assert.equal(validCustom.ok, true);
  if (validCustom.ok) {
    assert.equal(validCustom.failReason, "timeout");
  }
});
