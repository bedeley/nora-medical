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

function isSettledMomoStatus(status: string) {
  const normalized = String(status || "").toUpperCase();
  return (
    normalized === "SUCCESS" ||
    normalized === "SUCCESSFUL" ||
    normalized === "RECORDED" ||
    normalized === "RESOLVED_TO_CREDIT"
  );
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = String(user?.role || "");
  const isAdmin = role === "ADMIN";
  if (!session || !isAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-momo-post-all", 60_000, 20);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const recent = await prisma.payment.findMany({
    orderBy: { createdAt: "desc" },
    take: 300,
    select: { id: true, note: true },
  });

  const momoSettledIds = recent
    .map((p) => {
      const meta = parseMeta(p.note);
      if (!meta) return null;
      const method = String(meta.method || "").toLowerCase();
      if (method !== "momo") return null;
      const status = String(meta.status || "");
      return isSettledMomoStatus(status) ? p.id : null;
    })
    .filter((id): id is string => Boolean(id));

  if (!momoSettledIds.length) {
    return NextResponse.json({ ok: true, attempted: 0, posted: 0, skipped: 0 });
  }

  const postedRows = await prisma.journalEntry.findMany({
    where: {
      sourceType: "PAYMENT",
      status: "POSTED",
      OR: [
        { sourceId: { in: momoSettledIds } },
        ...momoSettledIds.map((id) => ({ sourceId: { startsWith: `${id}:` } })),
      ],
    },
    select: { sourceId: true },
  });
  const alreadyPosted = new Set(
    postedRows.map((r) => String(r.sourceId || "").split(":")[0]).filter(Boolean),
  );
  const targets = momoSettledIds.filter((id) => !alreadyPosted.has(id));

  let posted = 0;
  const failed: Array<{ paymentId: string; error: string }> = [];
  for (const paymentId of targets) {
    try {
      const entry = await postPaymentEntry({ paymentId });
      if (entry?.id) {
        posted += 1;
      } else {
        const fallback = await prisma.journalEntry.findFirst({
          where: {
            sourceType: "PAYMENT",
            status: "POSTED",
            OR: [{ sourceId: paymentId }, { sourceId: { startsWith: `${paymentId}:` } }],
          },
          select: { id: true },
        });
        if (fallback?.id) posted += 1;
      }
    } catch (error) {
      failed.push({
        paymentId,
        error: error instanceof Error ? error.message : "Failed to post payment",
      });
    }
  }

  await prisma.auditLog.create({
    data: {
      actorId: user?.id || null,
      action: "MOMO_BULK_POST_RETRY",
      entityType: "PAYMENT",
      entityId: "BULK",
      meta: JSON.stringify({
        attempted: targets.length,
        posted,
        failed: failed.length,
        failedPayments: failed.slice(0, 20),
      }),
    },
  });

  return NextResponse.json({
    ok: true,
    attempted: targets.length,
    posted,
    skipped: momoSettledIds.length - targets.length,
    failedCount: failed.length,
    failedPayments: failed,
  });
}
