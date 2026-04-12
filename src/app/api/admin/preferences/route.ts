import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

type PreferenceBody = {
  key?: string;
  value?: unknown;
  sourcePage?: string;
  section?: string;
  auditAction?: string;
  resultSummary?: string;
  skipAudit?: boolean;
} | null;

function normalizeAuditText(value: unknown, maxLength = 240) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function stableJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarizePreferenceValue(key: string, value: unknown) {
  if (key === "inventory.savedFilters" && Array.isArray(value)) {
    const names = value
      .map((item) =>
        item && typeof item === "object" && "name" in item
          ? String((item as { name?: unknown }).name || "").trim()
          : "",
      )
      .filter(Boolean)
      .slice(0, 10);
    return {
      savedFilterCount: value.length,
      savedFilterNames: names,
    };
  }
  if (key === "inventory.columns.order" && Array.isArray(value)) {
    return {
      columnCount: value.length,
      columnOrder: value.map((item) => String(item)).slice(0, 30),
    };
  }
  if (
    key === "inventory.columns.visibility" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const entries = Object.entries(value as Record<string, unknown>);
    return {
      visibleColumns: entries
        .filter(([, isVisible]) => Boolean(isVisible))
        .map(([column]) => column),
      hiddenColumns: entries
        .filter(([, isVisible]) => !Boolean(isVisible))
        .map(([column]) => column),
    };
  }
  return {
    valueType: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
  };
}

function inferInventoryPreferenceAction(
  key: string,
  previousValue: unknown,
  nextValue: unknown,
) {
  if (key === "inventory.savedFilters") {
    const previousCount = Array.isArray(previousValue) ? previousValue.length : 0;
    const nextCount = Array.isArray(nextValue) ? nextValue.length : 0;
    if (nextCount > previousCount) return "INVENTORY_FILTER_SAVE";
    if (nextCount < previousCount) return "INVENTORY_FILTER_REMOVE";
    return "INVENTORY_FILTER_UPDATE";
  }
  if (key.startsWith("inventory.columns.")) return "INVENTORY_LAYOUT_UPDATE";
  return "USER_PREFERENCE_UPDATE";
}

function inferInventoryPreferenceSection(key: string) {
  if (key === "inventory.savedFilters") return "saved-filters";
  if (key.startsWith("inventory.columns.")) return "layout";
  return "preferences";
}

function inferInventoryPreferenceSummary(key: string, nextValue: unknown) {
  if (key === "inventory.savedFilters") {
    const count = Array.isArray(nextValue) ? nextValue.length : 0;
    return `Inventory saved filters updated (${count} saved).`;
  }
  if (key === "inventory.columns.order") {
    const count = Array.isArray(nextValue) ? nextValue.length : 0;
    return `Inventory column order updated (${count} columns).`;
  }
  if (
    key === "inventory.columns.visibility" &&
    nextValue &&
    typeof nextValue === "object" &&
    !Array.isArray(nextValue)
  ) {
    const visibleCount = Object.values(nextValue as Record<string, unknown>).filter(Boolean).length;
    return `Inventory column visibility updated (${visibleCount} optional columns visible).`;
  }
  return `Preference "${key}" updated.`;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || !user || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const key = (searchParams.get("key") || "").trim();
  if (!key) {
    return NextResponse.json({ error: "Missing key" }, { status: 400 });
  }

  const pref = await prisma.userPreference.findUnique({
    where: { userId_key: { userId: user.id, key } },
    select: { value: true },
  });

  return NextResponse.json({ key, value: pref?.value ?? null });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || !user || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-preferences", 60_000, 120);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as PreferenceBody;
  const key = (body?.key || "").trim();
  if (!key) {
    return NextResponse.json({ error: "Missing key" }, { status: 400 });
  }

  const value = body?.value ?? null;
  const valueInput = value === null ? Prisma.JsonNull : value;
  const previousPref = await prisma.userPreference.findUnique({
    where: { userId_key: { userId: user.id, key } },
    select: { value: true },
  });

  const pref = await prisma.userPreference.upsert({
    where: { userId_key: { userId: user.id, key } },
    update: { value: valueInput },
    create: { userId: user.id, key, value: valueInput },
    select: { value: true },
  });

  const previousValue = previousPref?.value ?? null;
  const nextValue = pref.value ?? null;
  const changed = stableJson(previousValue) !== stableJson(nextValue);
  const sourcePage =
    normalizeAuditText(body?.sourcePage, 120) ||
    (key.startsWith("inventory.") ? "admin/inventory" : null);

  if (changed && !body?.skipAudit && sourcePage) {
    const section =
      normalizeAuditText(body?.section, 120) || inferInventoryPreferenceSection(key);
    const auditAction =
      normalizeAuditText(body?.auditAction, 120) ||
      inferInventoryPreferenceAction(key, previousValue, nextValue);
    const resultSummary =
      normalizeAuditText(body?.resultSummary, 240) ||
      inferInventoryPreferenceSummary(key, nextValue);

    void recordAuditLog({
      actorId: user.id,
      action: auditAction,
      entityType: "USER_PREFERENCE",
      entityId: key.slice(0, 120),
      request: req,
      meta: {
        key,
        sourcePage,
        section,
        previousValueSummary: summarizePreferenceValue(key, previousValue),
        nextValueSummary: summarizePreferenceValue(key, nextValue),
        resultSummary,
      },
    });
  }

  return NextResponse.json({ key, value: pref.value });
}
