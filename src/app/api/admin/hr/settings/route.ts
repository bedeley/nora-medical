import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { assertSameOrigin } from "@/lib/origin";

const updateSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

export async function GET(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const keysParam = searchParams.get("keys")?.trim() || "";
  const keys = keysParam
    ? keysParam.split(",").map((key) => key.trim()).filter(Boolean)
    : [];

  const rows = keys.length
    ? await prisma.siteSetting.findMany({ where: { key: { in: keys } } })
    : await prisma.siteSetting.findMany();

  const values: Record<string, unknown> = {};
  rows.forEach((row) => {
    values[row.key] = row.value;
  });

  return NextResponse.json({ values });
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const value = parsed.data.value as Prisma.InputJsonValue;
  const setting = await prisma.siteSetting.upsert({
    where: { key: parsed.data.key },
    update: { value },
    create: { key: parsed.data.key, value },
  });

  return NextResponse.json(setting);
}
