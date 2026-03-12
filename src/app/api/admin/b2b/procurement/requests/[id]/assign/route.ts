import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import {
  notifyCustomerProcurementAssigned,
  type ProcurementRequestSnapshot,
} from "@/lib/b2b-procurement-notifications";

const schema = z.object({
  accountManagerId: z.string().min(1),
  note: z.string().max(500).optional(),
});

function parseSnapshot(meta: string | null) {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as { snapshot?: ProcurementRequestSnapshot };
    return parsed.snapshot ?? null;
  } catch {
    return null;
  }
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-b2b-procurement-assign", 60_000, 60);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  const params = await context.params;
  const requestId = params.id;

  const last = await prisma.auditLog.findFirst({
    where: {
      entityType: "B2B_PROCUREMENT_REQUEST",
      entityId: requestId,
      action: {
        in: [
          "B2B_PROCUREMENT_REQUEST_CREATED",
          "B2B_PROCUREMENT_REQUEST_ASSIGNED",
          "B2B_PROCUREMENT_REQUEST_STATUS_UPDATED",
        ],
      },
    },
    orderBy: { createdAt: "desc" },
  });
  const current = parseSnapshot(last?.meta || null);
  if (!current) return NextResponse.json({ error: "Request not found" }, { status: 404 });
  if (current.status === "REJECTED" || current.status === "CLOSED") {
    return NextResponse.json(
      { error: `Request is ${current.status}. Reopen it before reassignment.` },
      { status: 409 },
    );
  }

  const next: ProcurementRequestSnapshot = {
    ...current,
    status: current.status === "SUBMITTED" ? "IN_REVIEW" : current.status,
    accountManagerId: parsed.data.accountManagerId,
    updatedAt: new Date().toISOString(),
  };
  const manager = await prisma.user.findUnique({
    where: { id: parsed.data.accountManagerId },
    select: { name: true, email: true },
  });
  const actor = user?.id
    ? await prisma.user.findUnique({
        where: { id: user.id },
        select: { name: true, email: true },
      })
    : null;
  const notification = await notifyCustomerProcurementAssigned(
    next,
    actor?.name || actor?.email || null,
    manager?.name || manager?.email || null,
  ).catch((error: unknown) => ({
    attempted: true,
    channel: "none" as const,
    ok: false,
    detail: error instanceof Error ? error.message : "Notification error",
  }));

  await prisma.auditLog.create({
    data: {
      actorId: user?.id || null,
      action: "B2B_PROCUREMENT_REQUEST_ASSIGNED",
      entityType: "B2B_PROCUREMENT_REQUEST",
      entityId: requestId,
      meta: JSON.stringify({
        snapshot: next,
        assignment: {
          accountManagerId: parsed.data.accountManagerId,
          note: parsed.data.note?.trim() || null,
        },
        notification,
      }),
    },
  });

  return NextResponse.json({ ok: true, snapshot: next, notification });
}
