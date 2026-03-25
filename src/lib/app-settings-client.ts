export type AppSettingAuditPayload = {
  sourcePage?: string;
  operation?: "save" | "reset";
  section?: string;
};

export type AppSettingSnapshot<TValue> = {
  key: string;
  value: TValue | null;
  updatedAt: string | null;
};

type SaveSingleInput = {
  key: string;
  value: unknown;
  expectedUpdatedAt?: string | null;
};

type SaveManyInput = {
  updates: Array<{ key: string; value: unknown; expectedUpdatedAt?: string | null }>;
};

type SaveBaseInput = {
  audit?: AppSettingAuditPayload | null;
};

export async function fetchJsonOrThrow<T>(res: Response, fallbackError: string) {
  const payload = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(typeof payload?.error === "string" && payload.error.trim() ? payload.error : fallbackError);
  }
  return payload;
}

export async function fetchAppSetting<TValue>(key: string) {
  const res = await fetch(`/api/admin/settings/app?key=${encodeURIComponent(key)}`);
  return fetchJsonOrThrow<AppSettingSnapshot<TValue>>(res, `Failed to load setting: ${key}.`);
}

export async function saveAppSetting(
  payload: (SaveSingleInput | SaveManyInput) & SaveBaseInput,
  fallbackError = "Failed to save setting.",
) {
  const res = await fetch("/api/admin/settings/app", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return fetchJsonOrThrow<Record<string, unknown>>(res, fallbackError);
}
