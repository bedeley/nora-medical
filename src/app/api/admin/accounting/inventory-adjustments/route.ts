import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { findClosedPeriod } from "@/lib/accounting-periods";

const bodySchema = z.object({
  productId: z.string().min(1),
  newUnitCost: z.number().min(0),
  reason: z.string().min(3).max(200),
});

const DEFAULT_ACCOUNT_CODES = {
  INVENTORY: "1200",
  COGS: "5000",
};

const DEFAULT_ACCOUNTS_BY_CODE: Record<
  string,
  { name: string; type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE" }
> = {
  "1200": { name: "Inventory", type: "ASSET" },
  "5000": { name: "Cost of Goods Sold", type: "EXPENSE" },
};

async function getAccountCodes() {
  const setting = await prisma.appSetting.findUnique({
    where: { key: "accounting.posting.accounts" },
  });
  const value = setting?.value && typeof setting.value === "object" ? setting.value : null;
  return {
    ...DEFAULT_ACCOUNT_CODES,
    ...(value as Record<string, string> | null),
  };
}

async function resolveAccounts(codes: string[]) {
  const rows = await prisma.ledgerAccount.findMany({
    where: { code: { in: codes } },
  });
  const map = new Map(rows.map((r) => [r.code, r.id]));
  if (map.size !== codes.length) {
    const missing = codes.filter((c) => !map.has(c));
    for (const code of missing) {
      const template = DEFAULT_ACCOUNTS_BY_CODE[code];
      if (!template) continue;
      await prisma.ledgerAccount.upsert({
        where: { code },
        update: { name: template.name, type: template.type, isActive: true },
        create: { code, name: template.name, type: template.type },
      });
    }
    const refreshed = await prisma.ledgerAccount.findMany({
      where: { code: { in: codes } },
    });
    return new Map(refreshed.map((r) => [r.code, r.id]));
  }
  return map;
}

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-inventory-revalue", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    const product = await prisma.product.findUnique({
      where: { id: parsed.data.productId },
      select: { id: true, name: true, stock: true, cost: true },
    });
    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    const stock = Number(product.stock || 0);
    const currentCost = Number(product.cost || 0);
    const newCost = Number(parsed.data.newUnitCost);
    const currentVal = stock * currentCost;
    const newVal = stock * newCost;
    const delta = Number((newVal - currentVal).toFixed(2));
    if (Math.abs(delta) < 0.01) {
      return NextResponse.json({ ok: true, message: "No adjustment required." });
    }

    const entryDate = new Date();
    const closedPeriod = await findClosedPeriod(entryDate);
    if (closedPeriod) {
      return NextResponse.json(
        { error: `Period "${closedPeriod.name}" is closed.` },
        { status: 400 },
      );
    }

    const accountCodes = await getAccountCodes();
    const inventoryCode = accountCodes.INVENTORY;
    const cogsCode = accountCodes.COGS;
    const accountMap = await resolveAccounts([inventoryCode, cogsCode]);
    if (!accountMap.get(inventoryCode) || !accountMap.get(cogsCode)) {
      return NextResponse.json({ error: "Missing ledger accounts for inventory adjustment." }, { status: 400 });
    }

    const memo = `Inventory revaluation - ${product.name}`;
    const lineDesc = `${product.name} (${parsed.data.reason})`;
    const amount = Math.abs(delta);
    const lines =
      delta > 0
        ? [
            { accountId: accountMap.get(inventoryCode) as string, debit: amount, credit: 0, description: lineDesc },
            { accountId: accountMap.get(cogsCode) as string, debit: 0, credit: amount, description: lineDesc },
          ]
        : [
            { accountId: accountMap.get(cogsCode) as string, debit: amount, credit: 0, description: lineDesc },
            { accountId: accountMap.get(inventoryCode) as string, debit: 0, credit: amount, description: lineDesc },
          ];

    await prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: product.id },
        data: { cost: newCost },
      });
      await tx.journalEntry.create({
        data: {
          entryDate,
          memo,
          sourceType: "MANUAL",
          sourceId: null,
          status: "POSTED",
          approvedById: (session.user as AuthenticatedUser).id,
          approvedAt: new Date(),
          lines: { create: lines },
        },
      });
    });

    try {
      await recordAuditLog({
        actorId: (session.user as AuthenticatedUser).id,
        action: "INVENTORY_REVALUATION",
        entityType: "PRODUCT",
        entityId: product.id,
        meta: {
          name: product.name,
          fromCost: currentCost,
          toCost: newCost,
          stock,
          delta,
          reason: parsed.data.reason,
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ ok: true, delta });
  } catch (error) {
    console.error("Inventory revaluation error:", error);
    return NextResponse.json({ error: "Failed to post inventory adjustment" }, { status: 500 });
  }
}
