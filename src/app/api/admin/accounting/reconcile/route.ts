import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseISO, isValid, startOfDay, endOfDay } from "date-fns";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");

  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (start && isValid(parseISO(start))) dateFilter.gte = startOfDay(parseISO(start));
  if (end && isValid(parseISO(end))) dateFilter.lte = endOfDay(parseISO(end));

  try {
    const [manualEntries, payments] = await Promise.all([
      prisma.journalEntry.findMany({
        where: {
          status: "POSTED",
          sourceType: "MANUAL",
          entryDate: Object.keys(dateFilter).length ? dateFilter : undefined,
        },
        orderBy: { entryDate: "desc" },
        include: {
          lines: {
            include: { account: true },
          },
        },
      }),
      prisma.payment.findMany({
        where: {
          createdAt: Object.keys(dateFilter).length ? dateFilter : undefined,
          deletedAt: null,
          status: { not: "VOID" },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, orderId: true, amount: true, note: true, refundDisposition: true, createdAt: true },
      }),
    ]);

    const manual = manualEntries.map((entry) => ({
      id: entry.id,
      entryDate: entry.entryDate,
      memo: entry.memo,
      lines: entry.lines.map((line) => ({
        id: line.id,
        accountCode: line.account.code,
        accountName: line.account.name,
        accountType: line.account.type,
        debit: Number(line.debit || 0),
        credit: Number(line.credit || 0),
        description: line.description || null,
      })),
    }));

    const autoApply: Array<{
      id: string;
      orderId: string | null;
      amount: number;
      createdAt: Date;
    }> = [];
    const returns: Array<{
      id: string;
      orderId: string | null;
      amount: number;
      refundDisposition: string | null;
      createdAt: Date;
    }> = [];

    for (const p of payments) {
      const note = typeof p.note === "string" ? p.note : "";
      const isAutoApply = note.includes("\"reference\":\"AUTO_APPLY\"");
      const isReturn = note.includes("\"reference\":\"ITEM_RETURN\"");
      if (isAutoApply) {
        autoApply.push({
          id: p.id,
          orderId: p.orderId ?? null,
          amount: Number(p.amount || 0),
          createdAt: p.createdAt,
        });
      }
      if (isReturn) {
        returns.push({
          id: p.id,
          orderId: p.orderId ?? null,
          amount: Number(p.amount || 0),
          refundDisposition: p.refundDisposition ? String(p.refundDisposition) : null,
          createdAt: p.createdAt,
        });
      }
    }

    return NextResponse.json({ manualEntries: manual, autoApply, returns });
  } catch (e) {
    console.error("Accounting reconcile error:", e);
    return NextResponse.json({ error: "Failed to load reconcile data" }, { status: 500 });
  }
}
