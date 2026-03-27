import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

const APP_SETTING_KEY = "hr.staff.savedViews";
const MAX_VIEWS = 30;

const viewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  filters: z.object({
    q: z.string().optional().default(""),
    status: z.string().optional().default("all"),
    department: z.string().optional().default("all"),
    role: z.string().optional().default("all"),
    completeness: z.string().optional().default("all"),
    sort: z.string().optional().default("recent"),
    pageSize: z.number().int().min(10).max(100).optional().default(25),
  }),
  updatedAt: z.string().min(1),
});

const payloadSchema = z.object({
  name: z.string().min(1).max(80),
  filters: viewSchema.shape.filters,
});

type StaffView = z.infer<typeof viewSchema>;

function parseViews(raw: Prisma.JsonValue | null | undefined): StaffView[] {
  if (!raw || !Array.isArray(raw)) return [];
  const parsed: StaffView[] = [];
  for (const item of raw) {
    const checked = viewSchema.safeParse(item);
    if (checked.success) parsed.push(checked.data);
  }
  return parsed.slice(0, MAX_VIEWS);
}

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

export async function GET() {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const setting = await prisma.appSetting.findUnique({
    where: { key: APP_SETTING_KEY },
    select: { value: true, updatedAt: true },
  });
  const items = parseViews(setting?.value);
  return NextResponse.json({ items, updatedAt: setting?.updatedAt ?? null });
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsedBody = payloadSchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Invalid input", details: parsedBody.error.flatten() }, { status: 400 });
  }

  const setting = await prisma.appSetting.findUnique({
    where: { key: APP_SETTING_KEY },
    select: { value: true },
  });
  const existing = parseViews(setting?.value);
  const nowIso = new Date().toISOString();
  const name = parsedBody.data.name.trim();
  const existingByName = existing.find((item) => item.name.toLowerCase() === name.toLowerCase());
  const nextItem: StaffView = {
    id: existingByName?.id || `staff_view_${Date.now()}`,
    name,
    filters: parsedBody.data.filters,
    updatedAt: nowIso,
  };
  const next = [nextItem, ...existing.filter((item) => item.id !== nextItem.id)].slice(0, MAX_VIEWS);
  const nextJson = next as unknown as Prisma.InputJsonValue;

  await prisma.appSetting.upsert({
    where: { key: APP_SETTING_KEY },
    update: { value: nextJson },
    create: { key: APP_SETTING_KEY, value: nextJson },
  });

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "HR_STAFF_VIEW_SAVE",
      entityType: "HRStaffView",
      entityId: nextItem.id,
      meta: {
        actor: { id: user.id, role: user.role },
        sourcePage: "admin/hr/staff",
        section: "saved-views",
        operation: "save_staff_view",
        before: existingByName || null,
        after: nextItem,
        status: "SUCCESS",
        resultSummary: "Staff saved view stored on server.",
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({ item: nextItem, items: next });
}

export async function DELETE(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const id = String((body as { id?: string })?.id || "").trim();
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });

  const setting = await prisma.appSetting.findUnique({
    where: { key: APP_SETTING_KEY },
    select: { value: true },
  });
  const existing = parseViews(setting?.value);
  const target = existing.find((item) => item.id === id) || null;
  const next = existing.filter((item) => item.id !== id);
  const nextJson = next as unknown as Prisma.InputJsonValue;

  await prisma.appSetting.upsert({
    where: { key: APP_SETTING_KEY },
    update: { value: nextJson },
    create: { key: APP_SETTING_KEY, value: nextJson },
  });

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "HR_STAFF_VIEW_DELETE",
      entityType: "HRStaffView",
      entityId: id,
      meta: {
        actor: { id: user.id, role: user.role },
        sourcePage: "admin/hr/staff",
        section: "saved-views",
        operation: "delete_staff_view",
        before: target,
        after: null,
        status: "SUCCESS",
        resultSummary: "Staff saved view removed from server.",
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({ ok: true, items: next });
}
