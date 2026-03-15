import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function toBoolFilter(value: string | null) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return null;
}

function toYmdStartUtc(value: string | null) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return new Date(`${raw}T00:00:00.000Z`);
}

function toYmdEndUtc(value: string | null) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return new Date(`${raw}T23:59:59.999Z`);
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q = String(searchParams.get("q") || "").trim();
  const bankAccountId = String(searchParams.get("bankAccountId") || "").trim();
  const matched = toBoolFilter(searchParams.get("matched"));
  const from = toYmdStartUtc(searchParams.get("from"));
  const to = toYmdEndUtc(searchParams.get("to"));
  const page = Math.max(1, Number(searchParams.get("page") || 1) || 1);
  const pageSize = Math.min(200, Math.max(10, Number(searchParams.get("pageSize") || 50) || 50));
  const skip = (page - 1) * pageSize;

  const where = {
    ...(bankAccountId ? { bankAccountId } : {}),
    ...(matched === null ? {} : { matched }),
    ...(from || to
      ? {
          postedAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        }
      : {}),
    ...(q
      ? {
          OR: [
            { description: { contains: q, mode: "insensitive" as const } },
            { reference: { contains: q, mode: "insensitive" as const } },
            { bankAccount: { name: { contains: q, mode: "insensitive" as const } } },
            { bankAccount: { bankName: { contains: q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.bankTransaction.count({ where }),
    prisma.bankTransaction.findMany({
      where,
      orderBy: [{ postedAt: "desc" }, { createdAt: "desc" }],
      skip,
      take: pageSize,
      select: {
        id: true,
        postedAt: true,
        amount: true,
        type: true,
        description: true,
        reference: true,
        matched: true,
        bankAccountId: true,
        bankAccount: {
          select: { id: true, name: true, bankName: true, currency: true, isActive: true },
        },
      },
    }),
  ]);

  return NextResponse.json({
    total,
    page,
    pageSize,
    rows,
  });
}

