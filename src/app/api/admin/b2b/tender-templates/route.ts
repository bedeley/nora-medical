import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";

const SETTINGS_KEY = "b2b_tender_templates_v1";

const templateSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(2).max(100),
  sourceType: z.enum(["PUBLIC_HOSPITAL", "PRIVATE_CLINIC", "NGO", "CORPORATE", "CUSTOM"]).default("CUSTOM"),
  validityDays: z.number().int().min(1).max(365).optional(),
  leadTimeDays: z.number().int().min(0).max(365).optional(),
  paymentTerms: z.string().max(1000).optional(),
  notes: z.string().max(4000).optional(),
});

type TemplateRow = z.infer<typeof templateSchema> & {
  id: string;
  updatedAt: string;
};

async function readTemplates(): Promise<TemplateRow[]> {
  const row = await prisma.siteSetting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return [];
  const value = row.value as unknown;
  if (!Array.isArray(value)) return [];
  return value.filter(Boolean) as TemplateRow[];
}

async function writeTemplates(items: TemplateRow[]) {
  await prisma.siteSetting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: items as unknown as object },
    create: { key: SETTINGS_KEY, value: items as unknown as object },
  });
}

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const items = await readTemplates();
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-b2b-tender-template-save", 60_000, 40);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const parsed = templateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  const payload = parsed.data;

  const items = await readTemplates();
  const now = new Date().toISOString();
  const id = payload.id?.trim() || `tpl-${randomUUID()}`;
  const next: TemplateRow = {
    id,
    name: payload.name.trim(),
    sourceType: payload.sourceType,
    validityDays: payload.validityDays,
    leadTimeDays: payload.leadTimeDays,
    paymentTerms: payload.paymentTerms?.trim() || undefined,
    notes: payload.notes?.trim() || undefined,
    updatedAt: now,
  };
  const idx = items.findIndex((x) => x.id === id);
  if (idx >= 0) items[idx] = next;
  else items.unshift(next);

  await writeTemplates(items.slice(0, 200));
  return NextResponse.json({ ok: true, item: next });
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-b2b-tender-template-delete", 60_000, 40);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  const url = new URL(req.url);
  const id = (url.searchParams.get("id") || "").trim();
  if (!id) return NextResponse.json({ error: "Template id is required" }, { status: 400 });

  const items = await readTemplates();
  const filtered = items.filter((x) => x.id !== id);
  await writeTemplates(filtered);
  return NextResponse.json({ ok: true });
}

