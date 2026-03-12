const MAX_TENDER_LINES = 500;
const MAX_LINE_LENGTH = 240;

export type SanitizedItemsText = {
  text: string;
  lineCount: number;
};

export function sanitizeTenderItemsText(raw: string): SanitizedItemsText {
  const normalized = String(raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // keep printable text; strip other controls
    .replace(/[^\x09\x0A\x20-\x7E]/g, " ")
    .replace(/[ \t]{2,}/g, " ");

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_TENDER_LINES)
    .map((line) => (line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) : line));

  return {
    text: lines.join("\n"),
    lineCount: lines.length,
  };
}

export function sanitizeFreeText(raw: string, maxLen: number) {
  return String(raw || "")
    .replace(/[^\x09\x0A\x20-\x7E]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, maxLen);
}

export function validateLineOverrideNos(
  lineNos: number[],
  maxLineNo: number,
): { ok: boolean; error?: string } {
  const seen = new Set<number>();
  for (const no of lineNos) {
    if (!Number.isInteger(no) || no < 1 || no > maxLineNo) {
      return { ok: false, error: `Invalid line override number: ${no}` };
    }
    if (seen.has(no)) {
      return { ok: false, error: `Duplicate line override number: ${no}` };
    }
    seen.add(no);
  }
  return { ok: true };
}
