import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { findClosedPeriod } from "@/lib/accounting-periods";
import { loadAccountTotals, parseDateRange, toNet } from "@/app/api/admin/accounting/reports/utils";

const INVENTORY_CODE = "1200";
const DEFAULT_OFFSET_CODES = ["5000", "6000"];
const EPSILON = 0.01;

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

async function resolveAccountId(code: string, name: string, type: "ASSET" | "EXPENSE") {
  const existing = await prisma.ledgerAccount.findUnique({ where: { code } });
  if (existing) return existing.id;
  const created = await prisma.ledgerAccount.create({ data: { code, name, type } });
  return created.id;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const asOf = searchParams.get("asOf");
    const asOfDate = asOf ? new Date(asOf) : new Date();
    if (Number.isNaN(asOfDate.getTime())) {
      return NextResponse.json({ error: "Invalid as-of date" }, { status: 400 });
    }
    if (asOf) {
      asOfDate.setHours(23, 59, 59, 999);
    }

    const totals = await loadAccountTotals(parseDateRange(null, asOfDate.toISOString()));
    const inventoryRow = totals.find((row) => row.code === INVENTORY_CODE) || null;
    const ledgerBalance = inventoryRow ? toNet(inventoryRow) : 0;

    const products = await prisma.product.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, sku: true, stock: true, cost: true },
      orderBy: { name: "asc" },
    });

    const items = products.map((p) => {
      const stock = Number(p.stock || 0);
      const cost = Number(p.cost || 0);
      const value = Number((stock * cost).toFixed(2));
      return {
        id: p.id,
        name: p.name,
        sku: p.sku || null,
        stock,
        cost,
        value,
      };
    });

    const valuationTotal = Number(
      items.reduce((sum, row) => sum + Number(row.value || 0), 0).toFixed(2),
    );
    const delta = Number((ledgerBalance - valuationTotal).toFixed(2));

    return NextResponse.json({
      asOf: asOfDate.toISOString(),
      inventoryAccount: inventoryRow
        ? { code: inventoryRow.code, name: inventoryRow.name }
        : null,
      ledgerBalance,
      valuationTotal,
      delta,
      items,
    });
  } catch (error) {
    console.error("Inventory valuation fetch error:", error);
    return NextResponse.json({ error: "Failed to load inventory valuation" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const asOfDate = body.asOf ? new Date(body.asOf) : new Date();
    if (Number.isNaN(asOfDate.getTime())) {
      return NextResponse.json({ error: "Invalid as-of date" }, { status: 400 });
    }
    if (body.asOf) {
      asOfDate.setHours(23, 59, 59, 999);
    }

    const closedPeriod = await findClosedPeriod(asOfDate);
    if (closedPeriod) {
      return NextResponse.json(
        { error: `Period "${closedPeriod.name}" is closed.` },
        { status: 400 },
      );
    }

    const totals = await loadAccountTotals(parseDateRange(null, asOfDate.toISOString()));
    const inventoryRow = totals.find((row) => row.code === INVENTORY_CODE) || null;
    const ledgerBalance = inventoryRow ? toNet(inventoryRow) : 0;

    const products = await prisma.product.findMany({
      where: { deletedAt: null },
      select: { stock: true, cost: true },
    });
    const valuationTotal = Number(
      products.reduce((sum, p) => sum + Number(p.cost || 0) * Number(p.stock || 0), 0).toFixed(2),
    );

    const difference = Number((ledgerBalance - valuationTotal).toFixed(2));
    if (Math.abs(difference) < EPSILON) {
      return NextResponse.json({ error: "No adjustment needed." }, { status: 400 });
    }

    const inventoryAccountId = inventoryRow?.accountId
      || (await resolveAccountId(INVENTORY_CODE, "Inventory", "ASSET"));

    let offsetAccount = null;
    if (typeof body.offsetAccountCode === "string" && body.offsetAccountCode.trim()) {
      offsetAccount = await prisma.ledgerAccount.findUnique({
        where: { code: body.offsetAccountCode.trim() },
      });
    }
    if (!offsetAccount) {
      for (const code of DEFAULT_OFFSET_CODES) {
        const candidate = await prisma.ledgerAccount.findUnique({ where: { code } });
        if (candidate) {
          offsetAccount = candidate;
          break;
        }
      }
    }
    if (!offsetAccount) {
      return NextResponse.json(
        { error: "Missing offset account (5000 or 6000)." },
        { status: 400 },
      );
    }

    const adjustment = Math.abs(difference);
    const inventoryDebit = difference < 0 ? adjustment : 0;
    const inventoryCredit = difference > 0 ? adjustment : 0;
    const offsetDebit = difference > 0 ? adjustment : 0;
    const offsetCredit = difference < 0 ? adjustment : 0;

    const entry = await prisma.journalEntry.create({
      data: {
        entryDate: asOfDate,
        memo: "Inventory valuation adjustment",
        sourceType: "MANUAL",
        status: "POSTED",
        approvedById: session.user?.id,
        approvedAt: new Date(),
        lines: {
          create: [
            {
              accountId: inventoryAccountId,
              debit: inventoryDebit,
              credit: inventoryCredit,
              description: "Inventory valuation alignment",
            },
            {
              accountId: offsetAccount.id,
              debit: offsetDebit,
              credit: offsetCredit,
              description: "Inventory valuation offset",
            },
          ],
        },
      },
    });

    return NextResponse.json({
      ok: true,
      entryId: entry.id,
      adjustment,
      ledgerBalance,
      valuationTotal,
      delta: difference,
    });
  } catch (error) {
    console.error("Inventory valuation adjust error:", error);
    return NextResponse.json({ error: "Failed to post adjustment" }, { status: 500 });
  }
}
