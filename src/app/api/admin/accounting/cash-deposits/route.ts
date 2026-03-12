import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { z } from "zod";
import { findClosedPeriod } from "@/lib/accounting-periods";

const depositSchema = z.object({
  amount: z.number().positive(),
  notes: z.string().max(200).optional(),
  bankAccountId: z.string().min(1),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  if (!session || (role !== "ADMIN" && role !== "ACCOUNTANT")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-cash-deposit", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = depositSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const amount = Number(parsed.data.amount);
  const notes = parsed.data.notes?.trim();
  const bankAccountId = parsed.data.bankAccountId.trim();
  const bankAccount = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!bankAccount) {
    return NextResponse.json({ error: "Bank account not found" }, { status: 404 });
  }
  const bankLabel = `${bankAccount.name}${bankAccount.bankName ? ` · ${bankAccount.bankName}` : ""}`;

  const entryDate = new Date();
  const closedPeriod = await findClosedPeriod(entryDate);
  if (closedPeriod) {
    return NextResponse.json(
      { error: `Cannot post cash deposit in closed period "${closedPeriod.name}".` },
      { status: 400 },
    );
  }

  const accounts = await prisma.ledgerAccount.findMany({
    where: { code: { in: ["1000", "1010"] } },
  });
  const byCode = new Map(accounts.map((acct) => [acct.code, acct.id]));
  if (!byCode.has("1000")) {
    const cash = await prisma.ledgerAccount.create({
      data: { code: "1000", name: "Cash", type: "ASSET" },
    });
    byCode.set("1000", cash.id);
  }
  if (!byCode.has("1010")) {
    const bank = await prisma.ledgerAccount.create({
      data: { code: "1010", name: "Bank", type: "ASSET" },
    });
    byCode.set("1010", bank.id);
  }

  const memoBase = `Cash deposit to ${bankLabel}`;
  const memo = notes ? `${memoBase} — ${notes}` : memoBase;
  const journal = await prisma.journalEntry.create({
    data: {
      entryDate,
      memo,
      sourceType: "MANUAL",
      status: "POSTED",
      approvedById: user?.id ?? null,
      approvedAt: new Date(),
      lines: {
        create: [
          {
            accountId: byCode.get("1010") as string,
            debit: amount,
            credit: 0,
            description: `Cash deposit to ${bankLabel}`,
          },
          {
            accountId: byCode.get("1000") as string,
            debit: 0,
            credit: amount,
            description: `Cash transfer from cash to ${bankLabel}`,
          },
        ],
      },
    },
  });

  return NextResponse.json({ ok: true, journalEntryId: journal?.id ?? null });
}
