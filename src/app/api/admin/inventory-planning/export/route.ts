import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { getInventoryPlanningData } from "@/lib/inventory-planning-data";
import { rateLimit } from "@/lib/rate-limit";

function getSourcePage(req: Request, fallback: string) {
  const value = String(new URL(req.url).searchParams.get("sourcePage") || "").trim();
  return value || fallback;
}

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT" || role === "STAFF";
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await rateLimit(req, "admin-inventory-plan-export", 60_000, 12);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  const sourcePage = getSourcePage(req, "admin/inventory-planning");
  const scope = String(new URL(req.url).searchParams.get("scope") || "all").trim().toLowerCase();
  const exportScope = scope === "suggestions" ? "suggestions" : "all";

  const data = await getInventoryPlanningData();
  const rows =
    exportScope === "suggestions"
      ? data.rows.filter((row) => Boolean(row.suggestion?.id))
      : data.rows;

  const header = [
    "Product",
    "SKU",
    "Category",
    "Supplier",
    "Stock",
    "Reserved",
    "OnOrder",
    "Available",
    "ReorderPoint",
    "SafetyStock",
    "LeadTimeDays",
    "ReviewPeriodDays",
    "MinOrderQty",
    "TargetStock",
    "AvgDailyDemand",
    "UnitsSold",
    "DaysOfCover",
    "PlanSource",
    "SuggestionStatus",
    "SuggestedQty",
    "SuggestionReason",
    "DemandSnapshotCapturedAt",
    "SuggestionCreatedAt",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    const avgDailyDemand = row.demand ? Number(row.demand.avgDailyDemand) : 0;
    const daysOfCover =
      avgDailyDemand > 0 ? Math.max(0, row.available) / avgDailyDemand : null;
    const suggestionStatus = row.suggestion?.id
      ? "open"
      : row.suggestion
        ? "live"
        : "none";
    lines.push([
      JSON.stringify(row.name),
      JSON.stringify(row.sku || ""),
      JSON.stringify(row.category || ""),
      JSON.stringify(row.supplier || ""),
      JSON.stringify(row.stock),
      JSON.stringify(row.reserved),
      JSON.stringify(row.onOrder),
      JSON.stringify(row.available),
      JSON.stringify(row.effectivePlan.reorderPoint),
      JSON.stringify(row.effectivePlan.safetyStock),
      JSON.stringify(row.effectivePlan.leadTimeDays),
      JSON.stringify(row.effectivePlan.reviewPeriodDays),
      JSON.stringify(row.effectivePlan.minOrderQty),
      JSON.stringify(row.effectivePlan.targetStock),
      JSON.stringify(row.demand?.avgDailyDemand || ""),
      JSON.stringify(row.demand?.unitsSold ?? ""),
      JSON.stringify(daysOfCover == null ? "" : daysOfCover.toFixed(2)),
      JSON.stringify(row.planSource),
      JSON.stringify(suggestionStatus),
      JSON.stringify(row.suggestion?.suggestedQty ?? ""),
      JSON.stringify(row.suggestion?.reason || ""),
      JSON.stringify(row.demand?.capturedAt || ""),
      JSON.stringify(row.suggestion?.createdAt || ""),
    ].join(","));
  }

  const csv = lines.join("\n");
  const fileName =
    exportScope === "suggestions"
      ? "inventory_restock_suggestions.csv"
      : "inventory_planning_snapshot.csv";
  try {
    await recordAuditLog({
      actorId: (session.user as AuthenticatedUser).id,
      action: "ADMIN_EXPORT_DOWNLOAD",
      entityType: "REPORT",
      entityId: "INVENTORY_PLANNING",
      request: req,
      meta: {
        area: "inventory-planning",
        format: "CSV",
        fileName,
        rowCount: rows.length,
        columnCount: header.length,
        sourcePage,
        scope: exportScope,
        resultSummary:
          exportScope === "suggestions"
            ? `Downloaded inventory planning CSV with ${rows.length} saved open suggestion row(s).`
            : `Downloaded inventory planning snapshot CSV with ${rows.length} row(s).`,
      },
    });
  } catch {
    // best-effort
  }
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=${fileName.replace(".csv", "")}_${Date.now()}.csv`,
    },
  });
}
