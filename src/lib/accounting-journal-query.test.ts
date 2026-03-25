import assert from "node:assert/strict";
import test from "node:test";
import {
  JOURNAL_IDS_ONLY_MAX,
  applyIdsOnlyCap,
  compareJournalStatus,
  normalizeJournalSearchQuery,
} from "@/lib/accounting-journal-query";

test("normalizeJournalSearchQuery trims valid input", () => {
  const result = normalizeJournalSearchQuery("  invoice  ");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.q, "invoice");
});

test("normalizeJournalSearchQuery rejects overly long input", () => {
  const long = "x".repeat(121);
  const result = normalizeJournalSearchQuery(long);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "Search text is too long. Please use 120 characters or fewer.");
});

test("compareJournalStatus uses business order in asc mode", () => {
  const rows = [
    { status: "VOID", entryDate: new Date("2026-03-01T00:00:00.000Z"), createdAt: new Date("2026-03-01T01:00:00.000Z") },
    { status: "POSTED", entryDate: new Date("2026-03-01T00:00:00.000Z"), createdAt: new Date("2026-03-01T01:00:00.000Z") },
    { status: "DRAFT", entryDate: new Date("2026-03-01T00:00:00.000Z"), createdAt: new Date("2026-03-01T01:00:00.000Z") },
  ];
  rows.sort((a, b) => compareJournalStatus(a, b, "asc"));
  assert.deepEqual(rows.map((row) => row.status), ["DRAFT", "POSTED", "VOID"]);
});

test("compareJournalStatus uses business order in desc mode", () => {
  const rows = [
    { status: "VOID", entryDate: new Date("2026-03-01T00:00:00.000Z"), createdAt: new Date("2026-03-01T01:00:00.000Z") },
    { status: "POSTED", entryDate: new Date("2026-03-01T00:00:00.000Z"), createdAt: new Date("2026-03-01T01:00:00.000Z") },
    { status: "DRAFT", entryDate: new Date("2026-03-01T00:00:00.000Z"), createdAt: new Date("2026-03-01T01:00:00.000Z") },
  ];
  rows.sort((a, b) => compareJournalStatus(a, b, "desc"));
  assert.deepEqual(rows.map((row) => row.status), ["VOID", "POSTED", "DRAFT"]);
});

test("applyIdsOnlyCap enforces default cap and reports truncation", () => {
  const ids = Array.from({ length: JOURNAL_IDS_ONLY_MAX + 10 }, (_, idx) => `id-${idx + 1}`);
  const result = applyIdsOnlyCap(ids);
  assert.equal(result.truncated, true);
  assert.equal(result.total, JOURNAL_IDS_ONLY_MAX + 10);
  assert.equal(result.ids.length, JOURNAL_IDS_ONLY_MAX);
});

test("applyIdsOnlyCap preserves full list when under cap", () => {
  const ids = ["a", "b", "c"];
  const result = applyIdsOnlyCap(ids, 10);
  assert.equal(result.truncated, false);
  assert.equal(result.total, 3);
  assert.deepEqual(result.ids, ids);
});

