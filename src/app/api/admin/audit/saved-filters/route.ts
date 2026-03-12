import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "STAFF" || role === "ACCOUNTANT";
}

function normalizeName(value: unknown) {
  const name = String(value || "").trim();
  if (!name) return "";
  return name.slice(0, 60);
}

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const currentUser = user as AuthenticatedUser;

  const ownerId = currentUser.id;
  const rows = await prisma.auditSavedFilter.findMany({
    where: {
      OR: [
        { ownerId },
        {
          isShared: true,
          ownerId: { not: ownerId },
        },
      ],
    },
    include: {
      owner: { select: { id: true, name: true, email: true } },
    },
    orderBy: [{ ownerId: "asc" }, { createdAt: "desc" }],
  });

  return NextResponse.json({
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      state: row.state,
      isShared: row.isShared,
      owner: row.owner,
      canEdit: row.ownerId === ownerId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const currentUser = user as AuthenticatedUser;
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-audit-saved-filters", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as
    | { name?: unknown; state?: unknown; isShared?: unknown }
    | null;
  const name = normalizeName(body?.name);
  if (!name || name.length < 3) {
    return NextResponse.json(
      { error: "Filter name must be at least 3 characters." },
      { status: 400 },
    );
  }
  if (!body || typeof body.state !== "object" || body.state === null) {
    return NextResponse.json({ error: "Invalid filter state." }, { status: 400 });
  }
  const ownerId = currentUser.id;
  const isShared = Boolean(body.isShared);
  const state = body.state as Prisma.InputJsonValue;

  const row = await prisma.auditSavedFilter.upsert({
    where: { ownerId_name: { ownerId, name } },
    create: {
      ownerId,
      name,
      isShared,
      state,
    },
    update: {
      isShared,
      state,
    },
  });

  await recordAuditLog({
    actorId: ownerId,
    action: "AUDIT_FILTER_SAVE",
    entityType: "AUDIT_SAVED_FILTER",
    entityId: row.id,
    meta: { name: row.name, isShared: row.isShared },
  });

  return NextResponse.json({
    id: row.id,
    name: row.name,
    state: row.state,
    isShared: row.isShared,
    canEdit: true,
    owner: { id: ownerId, name: currentUser.name || null, email: currentUser.email || null },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const currentUser = user as AuthenticatedUser;
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-audit-saved-filters-delete", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  const { searchParams } = new URL(req.url);
  const scope = (searchParams.get("scope") || "").toLowerCase();
  if (scope !== "mine") {
    return NextResponse.json({ error: "Invalid scope." }, { status: 400 });
  }

  const ownerId = currentUser.id;
  const result = await prisma.auditSavedFilter.deleteMany({ where: { ownerId } });
  await recordAuditLog({
    actorId: ownerId,
    action: "AUDIT_FILTER_REMOVE_ALL",
    entityType: "AUDIT_SAVED_FILTER",
    entityId: "all",
    meta: { removed: result.count },
  });
  return NextResponse.json({ ok: true, removed: result.count });
}
