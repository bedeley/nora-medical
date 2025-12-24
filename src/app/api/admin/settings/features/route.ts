import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

const KNOWN_FEATURES = [
  {
    key: "sms_notifications",
    label: "SMS Notifications",
    envKey: "SMS_NOTIFICATIONS_ENABLED",
  },
  {
    key: "momo_payouts",
    label: "MoMo Payouts (refunds via MoMo)",
    envKey: "MOMO_PAYOUTS_ENABLED",
  },
];

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const flags = await prisma.featureFlag.findMany();
  const byKey = new Map(flags.map((f) => [f.key, f.enabled]));

  const items = KNOWN_FEATURES.map((f) => {
    const envVal = (process.env[f.envKey as keyof NodeJS.ProcessEnv] || "").toLowerCase() === "1";
    const dbVal = byKey.has(f.key) ? Boolean(byKey.get(f.key)) : undefined;
    const effective = dbVal ?? envVal;
    return {
      key: f.key,
      label: f.label,
      envEnabled: envVal,
      dbEnabled: dbVal,
      effective,
    };
  });

  return NextResponse.json({ features: items });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    key?: string;
    enabled?: boolean;
  };
  const key = String(body.key || "");
  const enabled = Boolean(body.enabled);
  const known = KNOWN_FEATURES.find((f) => f.key === key);
  if (!known) {
    return NextResponse.json({ error: "Unknown feature key" }, { status: 400 });
  }

  const existing = await prisma.featureFlag.findUnique({ where: { key } });

  await prisma.featureFlag.upsert({
    where: { key },
    update: { enabled },
    create: { key, enabled },
  });

  try {
    await recordAuditLog({
      actorId: user?.id,
      action: "FEATURE_FLAG_UPDATE",
      entityType: "FEATURE_FLAG",
      entityId: key,
      meta: {
        key,
        from: existing?.enabled ?? null,
        to: enabled,
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({ ok: true });
}
