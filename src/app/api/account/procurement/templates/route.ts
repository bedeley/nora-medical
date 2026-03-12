import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { isCustomerB2B } from "@/lib/customer-profile";

const templateSchema = z.object({
  name: z.string().min(2).max(120),
  notes: z.string().max(2000).optional(),
  itemsText: z.string().min(2).max(6000),
  cadence: z.enum(["WEEKLY", "BIWEEKLY", "MONTHLY", "CUSTOM"]).default("MONTHLY"),
});

type ReorderTemplateSnapshot = {
  id: string;
  customerId: string;
  name: string;
  notes: string | null;
  itemsText: string;
  cadence: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "CUSTOM";
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

function parseSnapshot(meta: string | null) {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as { snapshot?: ReorderTemplateSnapshot };
    return parsed.snapshot ?? null;
  } catch {
    return null;
  }
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = (session.user as AuthenticatedUser).id;
  if (!(await isCustomerB2B(userId))) {
    return NextResponse.json({ error: "Procurement templates are enabled for B2B customer profiles only." }, { status: 403 });
  }

  const logs = await prisma.auditLog.findMany({
    where: {
      entityType: "B2B_REORDER_TEMPLATE",
      action: {
        in: ["B2B_REORDER_TEMPLATE_CREATED", "B2B_REORDER_TEMPLATE_UPDATED", "B2B_REORDER_TEMPLATE_ARCHIVED"],
      },
      actorId: userId,
    },
    orderBy: [{ entityId: "asc" }, { createdAt: "asc" }],
    take: 1000,
  });

  const latestById = new Map<string, ReorderTemplateSnapshot>();
  for (const log of logs) {
    const snapshot = parseSnapshot(log.meta);
    if (!snapshot) continue;
    if (snapshot.customerId !== userId) continue;
    latestById.set(log.entityId, snapshot);
  }

  const items = Array.from(latestById.values())
    .filter((item) => item.active)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "account-procurement-template-create", 60_000, 20);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const user = session.user as AuthenticatedUser;
  if (!(await isCustomerB2B(user.id))) {
    return NextResponse.json({ error: "Procurement templates are enabled for B2B customer profiles only." }, { status: 403 });
  }
  const parsed = templateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const now = new Date().toISOString();
  const id = `b2b-tpl-${randomUUID()}`;
  const payload = parsed.data;
  const snapshot: ReorderTemplateSnapshot = {
    id,
    customerId: user.id,
    name: payload.name.trim(),
    notes: payload.notes?.trim() || null,
    itemsText: payload.itemsText.trim(),
    cadence: payload.cadence,
    active: true,
    createdAt: now,
    updatedAt: now,
  };

  await prisma.auditLog.create({
    data: {
      actorId: user.id,
      action: "B2B_REORDER_TEMPLATE_CREATED",
      entityType: "B2B_REORDER_TEMPLATE",
      entityId: id,
      meta: JSON.stringify({ snapshot }),
    },
  });

  return NextResponse.json({ ok: true, templateId: id, snapshot });
}
