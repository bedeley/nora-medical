import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { findClosedPeriod } from "@/lib/accounting-periods";

const equitySchema = z.object({
  amount: z.number().positive(),
  notes: z.string().max(200).optional(),
  source: z.enum(["CASH", "BANK"]),
  bankAccountId: z.string().optional(),
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
  const limited = await rateLimit(req, "admin-equity-contribution", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = equitySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const amount = Number(parsed.data.amount);
  const notes = parsed.data.notes?.trim();
  const source = parsed.data.source;
  const bankAccountId = parsed.data.bankAccountId?.trim();

  if (source === "BANK" && !bankAccountId) {
    return NextResponse.json({ error: "Bank account is required." }, { status: 400 });
  }

  const bankAccount = bankAccountId
    ? await prisma.bankAccount.findUnique({ where: { id: bankAccountId } })
    : null;
  if (bankAccountId && !bankAccount) {
    return NextResponse.json({ error: "Bank account not found" }, { status: 404 });
  }

  const entryDate = new Date();
  const closedPeriod = await findClosedPeriod(entryDate);
  if (closedPeriod) {
    return NextResponse.json(
      { error: `Cannot post equity in closed period "${closedPeriod.name}".` },
      { status: 400 },
    );
  }

  const accounts = await prisma.ledgerAccount.findMany({
    where: { code: { in: ["1000", "1010", "3000"] } },
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
  if (!byCode.has("3000")) {
    const equity = await prisma.ledgerAccount.create({
      data: { code: "3000", name: "Owner's Equity", type: "EQUITY" },
    });
    byCode.set("3000", equity.id);
  }

  const bankLabel = bankAccount
    ? `${bankAccount.name}${bankAccount.bankName ? ` · ${bankAccount.bankName}` : ""}`
    : null;
  const memoBase =
    source === "BANK" ? `Owner equity contribution to ${bankLabel}` : "Owner equity contribution (cash)";
  const memo = notes ? `${memoBase} — ${notes}` : memoBase;

  const debitAccountCode = source === "BANK" ? "1010" : "1000";
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
            accountId: byCode.get(debitAccountCode) as string,
            debit: amount,
            credit: 0,
            description: memoBase,
          },
          {
            accountId: byCode.get("3000") as string,
            debit: 0,
            credit: amount,
            description: "Owner equity contribution",
          },
        ],
      },
    },
  });

  return NextResponse.json({ ok: true, journalEntryId: journal.id });
}
