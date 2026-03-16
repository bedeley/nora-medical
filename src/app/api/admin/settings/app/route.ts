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
    select: { value: true },
  });

  return NextResponse.json({ key, value: setting?.value ?? null });
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

  const body = (await req.json().catch(() => null)) as
    | { key?: string; value?: unknown; audit?: AppSettingAuditPayload | null }
    | null;
  const key = (body?.key || "").trim();
  if (!key) {
    return NextResponse.json({ error: "Missing key" }, { status: 400 });
  }

  const value = body?.value ?? null;
  const valueInput = value === null ? Prisma.JsonNull : value;

  const previous = await prisma.appSetting.findUnique({
    where: { key },
    select: { value: true },
  });

  const setting = await prisma.appSetting.upsert({
    where: { key },
    update: { value: valueInput },
    create: { key, value: valueInput },
    select: { value: true },
  });

  const isSensitiveKey = /secret|token|password|api[_-]?key|private/i.test(key);
  const previousValue = previous?.value ?? null;
  const newValue = setting.value ?? null;
  const previousText = previousValue === null ? null : JSON.stringify(previousValue);
  const newText = newValue === null ? null : JSON.stringify(newValue);
  const changedFields = changedObjectFields(previousValue, newValue);
  const sourcePage = String(body?.audit?.sourcePage || "admin/accounting/settings");
  const operation = body?.audit?.operation === "reset" ? "reset" : "save";
  const section = String(body?.audit?.section || key);
  const previewLimit = 300;

  await recordAuditLog({
    actorId: (session.user as AuthenticatedUser).id,
    action: "app-setting.update",
    entityType: "AppSetting",
    entityId: key,
    meta: {
      key,
      sourcePage,
      section,
      operation,
      actorRole: (session.user as AuthenticatedUser).role,
      changed: previousText !== newText,
      changedFieldCount: changedFields.length,
      changedFields,
      previousType: previousValue === null ? "NULL" : Array.isArray(previousValue) ? "ARRAY" : typeof previousValue,
      newType: newValue === null ? "NULL" : Array.isArray(newValue) ? "ARRAY" : typeof newValue,
      previousSummary: summarizeValue(previousValue),
      newSummary: summarizeValue(newValue),
      previousValuePreview: isSensitiveKey ? "[hidden]" : previousText?.slice(0, previewLimit) ?? null,
      newValuePreview: isSensitiveKey ? "[hidden]" : newText?.slice(0, previewLimit) ?? null,
      isSensitive: isSensitiveKey,
    },
  });

  return NextResponse.json({ key, value: setting.value });
}
