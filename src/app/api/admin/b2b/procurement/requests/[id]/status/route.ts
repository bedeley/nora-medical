import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import {
  notifyCustomerProcurementStatusUpdated,
  type ProcurementRequestSnapshot,
} from "@/lib/b2b-procurement-notifications";

const schema = z.object({
  status: z.enum(["IN_REVIEW", "QUOTED", "APPROVED", "REJECTED", "CLOSED"]),
  reopen: z.boolean().optional(),
  note: z.string().max(1000).optional(),
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
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-b2b-procurement-status", 60_000, 60);
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
  const isTerminal = current.status === "REJECTED" || current.status === "CLOSED";
  if (isTerminal) {
    const isExplicitReopen = parsed.data.reopen === true && parsed.data.status === "IN_REVIEW";
    if (!isExplicitReopen) {
      return NextResponse.json(
        { error: `Request is ${current.status}. Use Reopen to move it back to IN_REVIEW.` },
        { status: 409 },
      );
    }
    if (!parsed.data.note?.trim()) {
      return NextResponse.json(
        { error: "Reopen requires a workflow note (reason)." },
        { status: 400 },
      );
    }
  }
  if (
    (current.status === "QUOTED" || current.status === "APPROVED") &&
    parsed.data.status === "IN_REVIEW"
  ) {
    return NextResponse.json(
      { error: `Cannot move ${current.status} request back to IN_REVIEW.` },
      { status: 409 },
    );
  }
  if (
    (parsed.data.status === "QUOTED" || parsed.data.status === "APPROVED") &&
    !current.accountManagerId
  ) {
    return NextResponse.json(
      { error: "Assign an account manager before moving request to QUOTED/APPROVED." },
      { status: 409 },
    );
  }

  const next: ProcurementRequestSnapshot = {
    ...current,
    status: parsed.data.status,
    updatedAt: new Date().toISOString(),
  };
  const actor = user?.id
    ? await prisma.user.findUnique({
        where: { id: user.id },
        select: { name: true, email: true },
      })
    : null;
  const notification = await notifyCustomerProcurementStatusUpdated(
    next,
    current.status,
    actor?.name || actor?.email || null,
  ).catch((error: unknown) => ({
    attempted: true,
    channel: "none" as const,
    ok: false,
    detail: error instanceof Error ? error.message : "Notification error",
  }));

  await prisma.auditLog.create({
    data: {
      actorId: user?.id || null,
      action: "B2B_PROCUREMENT_REQUEST_STATUS_UPDATED",
      entityType: "B2B_PROCUREMENT_REQUEST",
      entityId: requestId,
      meta: JSON.stringify({
        snapshot: next,
        statusUpdate: {
          from: current.status,
          to: parsed.data.status,
          reopen: parsed.data.reopen === true,
          note: parsed.data.note?.trim() || null,
        },
        notification,
      }),
    },
  });

  return NextResponse.json({ ok: true, snapshot: next, notification });
}
