import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInterviewNotes,
  formatUtcIsoToLocalInput,
  INTERVIEW_META_PREFIX,
  parseLocalDateTimeToUtcIso,
  parseInterviewFromNotes,
} from "@/lib/hr-hiring-interview-meta";

test("parseInterviewFromNotes reads plain text and marker payload", () => {
  const notes = `Candidate prefers afternoon.\n${INTERVIEW_META_PREFIX} {"scheduledAt":"2026-03-26T14:00:00.000Z","interviewer":"Nora Admin","outcome":null}`;
  const parsed = parseInterviewFromNotes(notes);
  assert.equal(parsed.plain, "Candidate prefers afternoon.");
  assert.equal(parsed.meta?.interviewer, "Nora Admin");
  assert.equal(parsed.meta?.scheduledAt, "2026-03-26T14:00:00.000Z");
});

test("parseInterviewFromNotes ignores invalid marker JSON", () => {
  const notes = `Keep in pipeline.\n${INTERVIEW_META_PREFIX} {not-json}`;
  const parsed = parseInterviewFromNotes(notes);
  assert.equal(parsed.plain, "Keep in pipeline.");
  assert.equal(parsed.meta, null);
});

test("buildInterviewNotes appends marker and round-trips with parse", () => {
  const notes = buildInterviewNotes("Strong communication.", {
    scheduledAt: "2026-03-27T10:30:00.000Z",
    interviewer: "Hiring Lead",
    outcome: "Pending",
  });
  const parsed = parseInterviewFromNotes(notes);
  assert.equal(parsed.plain, "Strong communication.");
  assert.equal(parsed.meta?.interviewer, "Hiring Lead");
  assert.equal(parsed.meta?.outcome, "Pending");
});

test("parseLocalDateTimeToUtcIso validates local datetime text", () => {
  const invalidShape = parseLocalDateTimeToUtcIso("2026-03-26 10:30");
  assert.equal(invalidShape.ok, false);

  const invalidValue = parseLocalDateTimeToUtcIso("2026-13-26T10:30");
  assert.equal(invalidValue.ok, false);

  const valid = parseLocalDateTimeToUtcIso("2026-03-26T10:30");
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(typeof valid.iso, "string");
    assert.match(String(valid.iso), /Z$/);
  }
});

test("formatUtcIsoToLocalInput returns datetime-local format", () => {
  const formatted = formatUtcIsoToLocalInput("2026-03-26T10:30:00.000Z");
  assert.match(formatted, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(formatUtcIsoToLocalInput("invalid"), "");
  assert.equal(formatUtcIsoToLocalInput(""), "");
});
