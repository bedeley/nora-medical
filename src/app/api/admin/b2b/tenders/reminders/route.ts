import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function getExpiryDate(updatedAt: Date, validityDays: number) {
  const base = new Date(updatedAt);
  base.setUTCDate(base.getUTCDate() + Math.max(0, Number(validityDays || 0)));
  return base;
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

  const rows = await prisma.tender.findMany({
    where: {
      deletedAt: null,
      status: { in: ["SUBMITTED", "SENT"] },
    },
    select: {
      id: true,
      tenderNumber: true,
      buyerName: true,
      buyerEmail: true,
      status: true,
      validityDays: true,
      updatedAt: true,
      sentAt: true,
      total: true,
      currency: true,
    },
    orderBy: { updatedAt: "desc" },
    take: 300,
  });

  const now = Date.now();
  const soonThresholdDays = Number(process.env.B2B_TENDER_EXPIRY_REMINDER_DAYS || 3);
  const items = rows
    .map((row) => {
      const expiryDate = getExpiryDate(row.sentAt || row.updatedAt, row.validityDays);
      const daysToExpiry = Math.ceil((expiryDate.getTime() - now) / (24 * 3600 * 1000));
      return {
        id: row.id,
        tenderNumber: row.tenderNumber,
        buyerName: row.buyerName,
        buyerEmail: row.buyerEmail,
        status: row.status,
        currency: row.currency,
        total: Number(row.total || 0),
        validityDays: row.validityDays,
        expiryDate: expiryDate.toISOString(),
        daysToExpiry,
        isExpiringSoon: daysToExpiry >= 0 && daysToExpiry <= soonThresholdDays,
      };
    })
    .filter((row) => row.daysToExpiry >= 0)
    .sort((a, b) => a.daysToExpiry - b.daysToExpiry);

  return NextResponse.json({
    soonThresholdDays,
    items,
  });
}

