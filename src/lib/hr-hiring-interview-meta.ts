export const INTERVIEW_META_PREFIX = "[INTERVIEW_META]";

export type HiringInterviewMeta = {
  scheduledAt?: string | null;
  interviewer?: string | null;
  outcome?: string | null;
};

export function parseInterviewFromNotes(notes?: string | null) {
  const text = String(notes || "");
  const lines = text.split("\n");
  const markerLine = lines.find((line) => line.trim().startsWith(INTERVIEW_META_PREFIX));
  let meta: HiringInterviewMeta | null = null;
  if (markerLine) {
    const raw = markerLine.trim().slice(INTERVIEW_META_PREFIX.length).trim();
    try {
      const parsed = JSON.parse(raw) as HiringInterviewMeta;
      meta = parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      meta = null;
    }
  }
  const plain = lines
    .filter((line) => !line.trim().startsWith(INTERVIEW_META_PREFIX))
    .join("\n")
    .trim();
  return { plain, meta };
}

export function buildInterviewNotes(plain: string, meta: HiringInterviewMeta) {
  const base = plain.trim();
  const marker = `${INTERVIEW_META_PREFIX} ${JSON.stringify(meta)}`;
  return base ? `${base}\n${marker}` : marker;
}

function toLocalDateTimeInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export function formatUtcIsoToLocalInput(iso?: string | null) {
  const text = String(iso || "").trim();
  if (!text) return "";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "";
  return toLocalDateTimeInputValue(date);
}

export function parseLocalDateTimeToUtcIso(localDateTime?: string | null) {
  const value = String(localDateTime || "").trim();
  if (!value) return { ok: true as const, iso: null };
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) {
    return {
      ok: false as const,
      error: "Use a valid local date and time (YYYY-MM-DDTHH:mm).",
    };
  }
  const [, y, m, d, h, min] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(min);
  const localDate = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    Number.isNaN(localDate.getTime()) ||
    localDate.getFullYear() !== year ||
    localDate.getMonth() !== month - 1 ||
    localDate.getDate() !== day ||
    localDate.getHours() !== hour ||
    localDate.getMinutes() !== minute
  ) {
    return { ok: false as const, error: "The selected local date/time is invalid." };
  }
  return { ok: true as const, iso: localDate.toISOString() };
}
