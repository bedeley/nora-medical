import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT" || role === "STAFF";
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const suggestions = await prisma.restockSuggestion.findMany({
    where: { status: "open" },
    orderBy: { createdAt: "desc" },
    include: {
      product: {
        select: { name: true, sku: true, stock: true, supplier: true, category: true },
      },
    },
  });

  const header = [
    "Product",
    "SKU",
    "Category",
    "Supplier",
    "Stock",
    "SuggestedQty",
    "Reason",
    "CreatedAt",
  ];
  const lines = [header.join(",")];
  for (const row of suggestions) {
    lines.push([
      JSON.stringify(row.product.name),
      JSON.stringify(row.product.sku || ""),
      JSON.stringify(row.product.category || ""),
      JSON.stringify(row.product.supplier || ""),
      JSON.stringify(row.product.stock),
      JSON.stringify(row.suggestedQty),
      JSON.stringify(row.reason || ""),
      JSON.stringify(row.createdAt.toISOString()),
    ].join(","));
  }

  const csv = lines.join("\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=inventory_restock_${Date.now()}.csv`,
    },
  });
}
