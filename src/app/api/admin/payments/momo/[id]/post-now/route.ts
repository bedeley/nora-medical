import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { postPaymentEntry } from "@/lib/accounting-posting";

function parseMeta(note: string | null) {
  if (!note) return null;
  try {
    return JSON.parse(note) as Record<string, unknown>;
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
  const role = String(user?.role || "");
  const isAdmin = role === "ADMIN";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-momo-post-now", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const params = await context.params;
  const payment = await prisma.payment.findUnique({ where: { id: params.id } });
  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });

  const meta = parseMeta(payment.note);
  const method = String(meta?.method || "").toLowerCase();
  if (method !== "momo") {
    return NextResponse.json({ error: "Only MoMo payments are supported." }, { status: 400 });
  }
  const status = String(meta?.status || "").toUpperCase();
  const isSettled =
    status === "SUCCESS" ||
    status === "SUCCESSFUL" ||
    status === "RECORDED" ||
    status === "RESOLVED_TO_CREDIT";
  if (!isSettled) {
    return NextResponse.json(
      { error: `Posting is only allowed for settled MoMo rows (current: ${status || "PENDING"}).` },
      { status: 409 },
    );
  }

  const existing = await prisma.journalEntry.findFirst({
    where: {
      sourceType: "PAYMENT",
      status: "POSTED",
      OR: [{ sourceId: payment.id }, { sourceId: { startsWith: `${payment.id}:` } }],
    },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json({ ok: true, alreadyPosted: true, journalEntryId: existing.id });
  }

  let postedEntryId: string | null = null;
  let errorMessage: string | null = null;
  try {
    const entry = await postPaymentEntry({ paymentId: payment.id });
    postedEntryId = entry?.id || null;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Failed to post MoMo payment";
  }

  if (!postedEntryId) {
    const retryExisting = await prisma.journalEntry.findFirst({
      where: {
        sourceType: "PAYMENT",
        status: "POSTED",
        OR: [{ sourceId: payment.id }, { sourceId: { startsWith: `${payment.id}:` } }],
      },
      select: { id: true },
    });
    postedEntryId = retryExisting?.id || null;
  }

  await prisma.auditLog.create({
    data: {
      actorId: user?.id || null,
      action: "MOMO_PAYMENT_POST_RETRY",
      entityType: "PAYMENT",
      entityId: payment.id,
      meta: JSON.stringify({
        status,
        posted: Boolean(postedEntryId),
        journalEntryId: postedEntryId,
        error: errorMessage,
      }),
    },
  });

  if (!postedEntryId) {
    return NextResponse.json(
      { error: errorMessage || "Could not post payment now. Check posting rules/accounts." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, journalEntryId: postedEntryId });
}
