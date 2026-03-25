import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

type AppSettingAuditPayload = {
  sourcePage?: string;
  operation?: "save" | "reset";
  section?: string;
};

type SettingsWriteBody = {
  key?: string;
  value?: unknown;
  expectedUpdatedAt?: string | null;
  updates?: Array<{ key?: string; value?: unknown; expectedUpdatedAt?: string | null }>;
  audit?: AppSettingAuditPayload | null;
};

type UserRole = AuthenticatedUser["role"];
type SettingPolicy = {
  writeRoles: UserRole[];
  validate: (value: unknown) => { ok: true; value: unknown } | { ok: false; error: string };
};

const VALID_STORE_CREDIT_POLICIES = new Set(["oldest_first", "current_order_first", "manual_apply_only"]);
const VALID_AUTO_RECOMPUTE_POLICIES = new Set(["off", "daily", "weekly"]);
const VALID_SCHEDULE_REPORT_TYPES = new Set(["VAT", "TRIAL_BALANCE", "INTEGRITY", "PL", "BALANCE_SHEET"]);
const VALID_SCHEDULE_FREQUENCIES = new Set(["WEEKLY", "MONTHLY"]);
const VALID_MANUAL_PERIOD_BASIS = new Set(["MONTHLY_CALENDAR", "FISCAL_PERIOD_END"]);

function summarizeValue(value: unknown) {
  if (value === null || value === undefined) return "empty";
  if (Array.isArray(value)) return `array (${value.length} item${value.length === 1 ? "" : "s"})`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return `object (${keys.length} field${keys.length === 1 ? "" : "s"})`;
  }
  if (typeof value === "string") return value.trim() ? "text value" : "blank text";
  return `${typeof value} value`;
}

function changedObjectFields(previous: unknown, next: unknown) {
  if (!previous || !next || typeof previous !== "object" || typeof next !== "object") {
    return [] as string[];
  }
  const prevObj = previous as Record<string, unknown>;
  const nextObj = next as Record<string, unknown>;
  const keySet = new Set([...Object.keys(prevObj), ...Object.keys(nextObj)]);
  return [...keySet].filter((k) => JSON.stringify(prevObj[k] ?? null) !== JSON.stringify(nextObj[k] ?? null));
}

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function normalizeBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "true" || text === "1" || text === "yes" || text === "on") return true;
  if (text === "false" || text === "0" || text === "no" || text === "off") return false;
  return null;
}

function normalizeInteger(value: unknown, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function normalizeNumber(value: unknown, min: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return null;
  return n;
}

function requireObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const SETTING_POLICIES: Record<string, SettingPolicy> = {
  "accounting.integrity.thresholds": {
    writeRoles: ["ADMIN", "ACCOUNTANT"],
    validate(value) {
      const obj = requireObject(value);
      if (!obj) return { ok: false, error: "Integrity thresholds must be an object." };
      const arDifference = normalizeNumber(obj.arDifference, 0);
      const inventoryDifference = normalizeNumber(obj.inventoryDifference, 0);
      const draftEntries = normalizeBoolean(obj.draftEntries);
      const negativeStock = normalizeBoolean(obj.negativeStock);
      if (arDifference === null || inventoryDifference === null) {
        return { ok: false, error: "Threshold values must be numeric and zero or greater." };
      }
      if (draftEntries === null || negativeStock === null) {
        return { ok: false, error: "Draft-entry and negative-stock flags must be true/false." };
      }
      return {
        ok: true,
        value: { arDifference, inventoryDifference, draftEntries, negativeStock },
      };
    },
  },
  "accounting.reporting.useLedger": {
    writeRoles: ["ADMIN"],
    validate(value) {
      const useLedger = normalizeBoolean(value);
      if (useLedger === null) return { ok: false, error: "Reporting source must be true or false." };
      return { ok: true, value: useLedger };
    },
  },
  "accounting.storeCredit.applyPolicy": {
    writeRoles: ["ADMIN", "ACCOUNTANT"],
    validate(value) {
      const policy = String(value ?? "").trim().toLowerCase();
      if (!VALID_STORE_CREDIT_POLICIES.has(policy)) {
        return { ok: false, error: "Store-credit policy must be oldest_first, current_order_first, or manual_apply_only." };
      }
      return { ok: true, value: policy };
    },
  },
  "accounting.bankTransactions.editWindowDays": {
    writeRoles: ["ADMIN"],
    validate(value) {
      const days = normalizeInteger(value, 0, 365);
      if (days === null) return { ok: false, error: "Bank transaction edit window must be a whole number between 0 and 365." };
      return { ok: true, value: days };
    },
  },
  "accounting.manualEntries.policy": {
    writeRoles: ["ADMIN"],
    validate(value) {
      const obj = requireObject(value);
      if (!obj) return { ok: false, error: "Manual entry policy must be an object." };
      const periodBasis = String(obj.periodBasis ?? "").trim().toUpperCase();
      const periodEndWindowDays = normalizeInteger(obj.periodEndWindowDays, 0, 31);
      const requireExceptionOutsideWindow = normalizeBoolean(obj.requireExceptionOutsideWindow);
      const minExceptionNoteLength = normalizeInteger(obj.minExceptionNoteLength, 8, 200);
      if (!VALID_MANUAL_PERIOD_BASIS.has(periodBasis)) {
        return { ok: false, error: "Manual entry period basis must be MONTHLY_CALENDAR or FISCAL_PERIOD_END." };
      }
      if (periodEndWindowDays === null || minExceptionNoteLength === null) {
        return { ok: false, error: "Manual entry days and note length are out of range." };
      }
      if (requireExceptionOutsideWindow === null) {
        return { ok: false, error: "Manual entry exception rule must be true or false." };
      }
      return {
        ok: true,
        value: {
          periodBasis,
          periodEndWindowDays,
          requireExceptionOutsideWindow,
          minExceptionNoteLength,
        },
      };
    },
  },
  "accounting.reconcile.thresholds": {
    writeRoles: ["ADMIN"],
    validate(value) {
      const obj = requireObject(value);
      if (!obj) return { ok: false, error: "Reconcile thresholds must be an object." };
      const currencyMinorPct = normalizeNumber(obj.currencyMinorPct, 0);
      const currencyWarningPct = normalizeNumber(obj.currencyWarningPct, 0);
      const marginMinorAbsPct = normalizeNumber(obj.marginMinorAbsPct, 0);
      const marginWarningAbsPct = normalizeNumber(obj.marginWarningAbsPct, 0);
      if (
        currencyMinorPct === null ||
        currencyWarningPct === null ||
        marginMinorAbsPct === null ||
        marginWarningAbsPct === null
      ) {
        return { ok: false, error: "Reconcile thresholds must be numeric and zero or greater." };
      }
      if (currencyWarningPct < currencyMinorPct || marginWarningAbsPct < marginMinorAbsPct) {
        return { ok: false, error: "Warning thresholds must be greater than or equal to minor thresholds." };
      }
      return {
        ok: true,
        value: {
          currencyMinorPct,
          currencyWarningPct,
          marginMinorAbsPct,
          marginWarningAbsPct,
        },
      };
    },
  },
  "accounting.reopen.monthlyWindowDays": {
    writeRoles: ["ADMIN", "ACCOUNTANT"],
    validate(value) {
      const days = normalizeInteger(value, 0, 365);
      if (days === null) return { ok: false, error: "Monthly reopen window must be a whole number between 0 and 365." };
      return { ok: true, value: days };
    },
  },
  "accounting.reopen.fiscalWindowDays": {
    writeRoles: ["ADMIN", "ACCOUNTANT"],
    validate(value) {
      const days = normalizeInteger(value, 0, 365);
      if (days === null) return { ok: false, error: "Fiscal reopen window must be a whole number between 0 and 365." };
      return { ok: true, value: days };
    },
  },
  "accounting.reopen.enforceFinalizedYearLock": {
    writeRoles: ["ADMIN", "ACCOUNTANT"],
    validate(value) {
      const lockEnabled = normalizeBoolean(value);
      if (lockEnabled === null) return { ok: false, error: "Finalized-year lock must be true or false." };
      return { ok: true, value: lockEnabled };
    },
  },
  "accounting.reopen.finalizedFiscalYears": {
    writeRoles: ["ADMIN", "ACCOUNTANT"],
    validate(value) {
      if (!Array.isArray(value)) {
        return { ok: false, error: "Finalized fiscal years must be a list of years." };
      }
      const years = Array.from(
        new Set(value.map((item) => Number(item)).filter((year) => Number.isInteger(year) && year >= 2000 && year <= 2100)),
      ).sort((a, b) => a - b);
      return { ok: true, value: years };
    },
  },
  "accounting.journal.policy": {
    writeRoles: ["ADMIN"],
    validate(value) {
      const obj = requireObject(value);
      if (!obj) return { ok: false, error: "Journal policy must be an object." };
      const recentWindowDays = normalizeInteger(obj.recentWindowDays, 1, 3660);
      const manualEntryAllowPnl = normalizeBoolean(obj.manualEntryAllowPnl);
      const archiveAfterMonths = normalizeInteger(obj.archiveAfterMonths, 1, 120);
      const archiveCronDryRun = normalizeBoolean(obj.archiveCronDryRun);
      if (recentWindowDays === null || archiveAfterMonths === null) {
        return { ok: false, error: "Journal policy day/month limits are out of range." };
      }
      if (manualEntryAllowPnl === null || archiveCronDryRun === null) {
        return { ok: false, error: "Journal policy toggles must be true or false." };
      }
      return {
        ok: true,
        value: {
          recentWindowDays,
          manualEntryAllowPnl,
          archiveAfterMonths,
          archiveCronDryRun,
        },
      };
    },
  },
  "accounting.periodClose.reminderDays": {
    writeRoles: ["ADMIN", "ACCOUNTANT"],
    validate(value) {
      const days = normalizeInteger(value, 1, 60);
      if (days === null) return { ok: false, error: "Reminder days must be a whole number between 1 and 60." };
      return { ok: true, value: days };
    },
  },
  "accounting.posting.accounts": {
    writeRoles: ["ADMIN"],
    validate(value) {
      const obj = requireObject(value);
      if (!obj) return { ok: false, error: "Posting account rules must be an object." };
      const next: Record<string, string> = {};
      for (const [key, val] of Object.entries(obj)) {
        const normalized = String(val ?? "").trim();
        if (!normalized) continue;
        if (normalized.length > 32) {
          return { ok: false, error: `Posting account code for ${key} is too long.` };
        }
        next[key] = normalized;
      }
      return { ok: true, value: next };
    },
  },
  "accounting.reports.pl.varianceNotes": {
    writeRoles: ["ADMIN", "ACCOUNTANT"],
    validate(value) {
      const obj = requireObject(value);
      if (!obj) return { ok: false, error: "Variance notes must be an object keyed by period." };
      const next: Record<string, string> = {};
      for (const [key, val] of Object.entries(obj)) {
        const note = String(val ?? "").trim();
        if (!note) continue;
        if (note.length > 2000) return { ok: false, error: "Variance note exceeds 2000 characters." };
        next[key] = note;
      }
      return { ok: true, value: next };
    },
  },
  "accounting.reports.pl.varianceThresholdPct": {
    writeRoles: ["ADMIN"],
    validate(value) {
      const threshold = normalizeNumber(value, 0);
      if (threshold === null || threshold > 1000) {
        return { ok: false, error: "Variance threshold must be a number between 0 and 1000." };
      }
      return { ok: true, value: threshold };
    },
  },
  "accounting.scheduledReports": {
    writeRoles: ["ADMIN", "ACCOUNTANT"],
    validate(value) {
      if (!Array.isArray(value)) {
        return { ok: false, error: "Scheduled reports must be a list." };
      }
      if (value.length > 200) return { ok: false, error: "Scheduled reports list is too large." };
      const next = value.map((row) => {
        const obj = requireObject(row);
        if (!obj) return null;
        const id = String(obj.id ?? "").trim();
        const name = String(obj.name ?? "").trim();
        const reportType = String(obj.reportType ?? "").trim().toUpperCase();
        const frequency = String(obj.frequency ?? "").trim().toUpperCase();
        const recipients = String(obj.recipients ?? "").trim();
        const enabled = normalizeBoolean(obj.enabled);
        if (!id || !name || !recipients || enabled === null) return null;
        if (!VALID_SCHEDULE_REPORT_TYPES.has(reportType) || !VALID_SCHEDULE_FREQUENCIES.has(frequency)) {
          return null;
        }
        return {
          id,
          name,
          reportType,
          frequency,
          recipients,
          enabled,
        };
      });
      if (next.some((item) => !item)) {
        return { ok: false, error: "One or more scheduled reports are invalid." };
      }
      return { ok: true, value: next };
    },
  },
  "accounting.integrity.lastSync": {
    writeRoles: ["ADMIN", "ACCOUNTANT"],
    validate(value) {
      const obj = requireObject(value);
      if (!obj) return { ok: false, error: "Last sync must include timestamp details." };
      const at = String(obj.at ?? "").trim();
      const by = String(obj.by ?? "").trim();
      if (!at || !by) return { ok: false, error: "Last sync requires both timestamp and actor." };
      return { ok: true, value: { at, by } };
    },
  },
  "inventoryPlanning.autoRecompute": {
    writeRoles: ["ADMIN", "ACCOUNTANT"],
    validate(value) {
      const mode = String(value ?? "").trim().toLowerCase();
      if (!VALID_AUTO_RECOMPUTE_POLICIES.has(mode)) {
        return { ok: false, error: "Auto recompute must be off, daily, or weekly." };
      }
      return { ok: true, value: mode };
    },
  },
  "inventoryPlanning.defaultReorderPoint": {
    writeRoles: ["ADMIN", "ACCOUNTANT"],
    validate(value) {
      const reorderPoint = normalizeInteger(value, 0, 1000000);
      if (reorderPoint === null) return { ok: false, error: "Default reorder point must be a whole number of 0 or higher." };
      return { ok: true, value: reorderPoint };
    },
  },
};

function validateSettingWrite(key: string, value: unknown, role: UserRole) {
  const policy = SETTING_POLICIES[key];
  if (!policy) {
    return { ok: false, status: 400, error: `Unsupported setting key: ${key}.` } as const;
  }
  if (!policy.writeRoles.includes(role)) {
    return { ok: false, status: 403, error: "You are not allowed to change this setting." } as const;
  }
  const validated = policy.validate(value);
  if (!validated.ok) {
    return { ok: false, status: 400, error: validated.error } as const;
  }
  return { ok: true, value: validated.value } as const;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const key = (searchParams.get("key") || "").trim();
  if (!key) {
    return NextResponse.json({ error: "Missing key" }, { status: 400 });
  }

  const setting = await prisma.appSetting.findUnique({
    where: { key },
    select: { key: true, value: true, updatedAt: true },
  });

  return NextResponse.json({
    key,
    value: setting?.value ?? null,
    updatedAt: setting?.updatedAt?.toISOString?.() ?? null,
  });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-app-settings", 60_000, 120);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as SettingsWriteBody | null;
  const actor = session.user as AuthenticatedUser;
  const role = actor.role;

  const sourcePage = String(body?.audit?.sourcePage || "admin/accounting/settings");
  const operation = body?.audit?.operation === "reset" ? "reset" : "save";
  const section = String(body?.audit?.section || (body?.key || "unknown"));

  const updatesInput = Array.isArray(body?.updates)
    ? body?.updates.map((item) => ({
        key: String(item?.key || "").trim(),
        value: item?.value ?? null,
        expectedUpdatedAt: item?.expectedUpdatedAt ?? null,
      }))
    : [];
  const isBulk = updatesInput.length > 0;
  const singleKey = String(body?.key || "").trim();
  const updates = isBulk
    ? updatesInput
    : singleKey
      ? [{ key: singleKey, value: body?.value ?? null, expectedUpdatedAt: body?.expectedUpdatedAt ?? null }]
      : [];

  if (updates.length === 0) {
    return NextResponse.json({ error: "Missing key" }, { status: 400 });
  }
  if (updates.some((item) => !item.key)) {
    return NextResponse.json({ error: "Each update requires a key." }, { status: 400 });
  }

  const duplicateKeys = updates
    .map((item) => item.key)
    .filter((key, index, arr) => arr.indexOf(key) !== index);
  if (duplicateKeys.length > 0) {
    return NextResponse.json({ error: `Duplicate setting keys in request: ${Array.from(new Set(duplicateKeys)).join(", ")}.` }, { status: 400 });
  }

  const validatedUpdates: Array<{ key: string; value: unknown; expectedUpdatedAt: string | null }> = [];
  for (const update of updates) {
    const validated = validateSettingWrite(update.key, update.value, role);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: validated.status });
    }
    validatedUpdates.push({ key: update.key, value: validated.value, expectedUpdatedAt: update.expectedUpdatedAt });
  }

  const keys = validatedUpdates.map((item) => item.key);
  const previousRows = await prisma.appSetting.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true, updatedAt: true },
  });
  const previousByKey = new Map(previousRows.map((row) => [row.key, row.value]));
  const previousUpdatedAtByKey = new Map(previousRows.map((row) => [row.key, row.updatedAt]));

  for (const update of validatedUpdates) {
    if (update.expectedUpdatedAt === undefined) continue;
    const current = previousUpdatedAtByKey.get(update.key) ?? null;
    const expected = update.expectedUpdatedAt;
    const currentIso = current?.toISOString?.() ?? null;
    if (expected === null) {
      if (currentIso !== null) {
        return NextResponse.json(
          { error: `Setting ${update.key} changed since you opened the page. Refresh and try again.` },
          { status: 409 },
        );
      }
      continue;
    }
    if (currentIso !== expected) {
      return NextResponse.json(
        { error: `Setting ${update.key} changed since you opened the page. Refresh and try again.` },
        { status: 409 },
      );
    }
  }

  const updatedRows = await prisma.$transaction(
    validatedUpdates.map((update) =>
      prisma.appSetting.upsert({
        where: { key: update.key },
        update: { value: (update.value === null ? Prisma.JsonNull : update.value) as Prisma.InputJsonValue },
        create: { key: update.key, value: (update.value === null ? Prisma.JsonNull : update.value) as Prisma.InputJsonValue },
        select: { key: true, value: true, updatedAt: true },
      }),
    ),
  );
  const updatedByKey = new Map(updatedRows.map((row) => [row.key, row.value]));

  const previewLimit = 300;
  const changedKeys: string[] = [];
  const changeDetails = validatedUpdates.map((update) => {
    const key = update.key;
    const previousValue = previousByKey.get(key) ?? null;
    const newValue = updatedByKey.get(key) ?? null;
    const previousText = previousValue === null ? null : JSON.stringify(previousValue);
    const newText = newValue === null ? null : JSON.stringify(newValue);
    const changed = previousText !== newText;
    if (changed) changedKeys.push(key);
    const changedFields = changedObjectFields(previousValue, newValue);
    const isSensitiveKey = /secret|token|password|api[_-]?key|private/i.test(key);
    return {
      key,
      changed,
      changedFields,
      changedFieldCount: changedFields.length,
      previousType: previousValue === null ? "NULL" : Array.isArray(previousValue) ? "ARRAY" : typeof previousValue,
      newType: newValue === null ? "NULL" : Array.isArray(newValue) ? "ARRAY" : typeof newValue,
      previousSummary: summarizeValue(previousValue),
      newSummary: summarizeValue(newValue),
      previousValuePreview: isSensitiveKey ? "[hidden]" : previousText?.slice(0, previewLimit) ?? null,
      newValuePreview: isSensitiveKey ? "[hidden]" : newText?.slice(0, previewLimit) ?? null,
      isSensitive: isSensitiveKey,
    };
  });

  const primaryKey = validatedUpdates[0]?.key || "unknown";
  await recordAuditLog({
    actorId: actor.id,
    action: "app-setting.update",
    entityType: "AppSetting",
    entityId: isBulk ? `bulk:${section}` : primaryKey,
    meta: {
      key: isBulk ? "multiple" : primaryKey,
      keys,
      sourcePage,
      section,
      operation,
      actorRole: role,
      changed: changedKeys.length > 0,
      changedKeys,
      changedKeyCount: changedKeys.length,
      updateCount: validatedUpdates.length,
      bulk: isBulk,
      changes: changeDetails,
    },
  });

  if (isBulk) {
    return NextResponse.json({
      ok: true,
      updated: updatedRows.map((row) => ({
        key: row.key,
        value: row.value,
        updatedAt: row.updatedAt?.toISOString?.() ?? null,
      })),
    });
  }
  const singleUpdated = updatedRows[0];
  return NextResponse.json({
    key: singleUpdated.key,
    value: singleUpdated.value,
    updatedAt: singleUpdated.updatedAt?.toISOString?.() ?? null,
  });
}
