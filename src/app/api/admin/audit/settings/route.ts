import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { Prisma } from "@prisma/client";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import {
  defaultAuditRiskSettingsFromEnv,
  normalizeAuditRiskSettings,
} from "@/lib/audit-risk-config";
import {
  AUDIT_RISK_SETTINGS_KEY,
  getEffectiveAuditRiskSettings,
} from "@/lib/audit-risk-settings.server";

function isAdmin(user?: AuthenticatedUser | null) {
  return user?.role === "ADMIN";
}

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAdmin(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await getEffectiveAuditRiskSettings();
  return NextResponse.json({
    ...payload,
    defaults: defaultAuditRiskSettingsFromEnv(),
  });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAdmin(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-audit-settings", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const effective = await getEffectiveAuditRiskSettings();
  if (!effective.editable) {
    return NextResponse.json(
      { error: `Settings are locked because AUDIT_SETTINGS_MODE=${effective.mode}.` },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => null)) as { settings?: unknown } | null;
  const defaults = defaultAuditRiskSettingsFromEnv();
  const nextSettings = normalizeAuditRiskSettings(body?.settings, defaults);

  const previous = await prisma.appSetting.findUnique({
    where: { key: AUDIT_RISK_SETTINGS_KEY },
    select: { value: true },
  });
  const previousNormalized = normalizeAuditRiskSettings(previous?.value, defaults);
  const isResetToDefaults = JSON.stringify(nextSettings) === JSON.stringify(defaults);

  await prisma.appSetting.upsert({
    where: { key: AUDIT_RISK_SETTINGS_KEY },
    update: { value: nextSettings as Prisma.InputJsonValue },
    create: { key: AUDIT_RISK_SETTINGS_KEY, value: nextSettings as Prisma.InputJsonValue },
  });

  await recordAuditLog({
    actorId: user?.id || null,
    action: isResetToDefaults ? "audit-risk-setting.reset" : "audit-risk-setting.update",
    entityType: "AppSetting",
    entityId: AUDIT_RISK_SETTINGS_KEY,
    meta: {
      key: AUDIT_RISK_SETTINGS_KEY,
      mode: effective.mode,
      changed: JSON.stringify(previousNormalized) !== JSON.stringify(nextSettings),
      resetToDefaults: isResetToDefaults,
      previous: previousNormalized,
      next: nextSettings,
    },
  });

  return NextResponse.json({
    mode: effective.mode,
    editable: true,
    settings: nextSettings,
    defaults,
  });
}
