import test from "node:test";
import assert from "node:assert/strict";

import {
  appendDashboardPeriodParams,
  buildDashboardAnomalyChips,
  buildDashboardPreviousBucketDelta,
  countDashboardActiveFilters,
  formatDashboardActivePeriodLabel,
  formatDashboardDeltaLabel,
  normalizeDashboardTrendRows,
} from "@/lib/admin-dashboard";

test("formatDashboardActivePeriodLabel renders all supported states", () => {
  assert.equal(formatDashboardActivePeriodLabel("", ""), "All time");
  assert.equal(formatDashboardActivePeriodLabel("2026-03-01", ""), "From 2026-03-01");
  assert.equal(formatDashboardActivePeriodLabel("", "2026-03-31"), "Up to 2026-03-31");
  assert.equal(
    formatDashboardActivePeriodLabel("2026-03-01", "2026-03-31"),
    "2026-03-01 to 2026-03-31",
  );
});

test("appendDashboardPeriodParams keeps existing query strings intact", () => {
  assert.equal(
    appendDashboardPeriodParams("/admin/orders?status=open", "2026-03-01", "2026-03-31"),
    "/admin/orders?status=open&start=2026-03-01&end=2026-03-31",
  );
  assert.equal(appendDashboardPeriodParams("/admin/orders", "", ""), "/admin/orders");
});

test("countDashboardActiveFilters includes non-default groupBy", () => {
  assert.equal(
    countDashboardActiveFilters(
      { start: "2026-03-01", end: "", customer: "Acme", category: "" },
      "month",
    ),
    3,
  );
  assert.equal(
    countDashboardActiveFilters(
      { start: "", end: "", customer: "", category: "" },
      "day",
    ),
    0,
  );
});

test("normalizeDashboardTrendRows adds fallback period, payrollExpense, and rollingRevenue", () => {
  const rows = normalizeDashboardTrendRows([
    { date: "2026-03-01", revenue: 100 },
    { date: "2026-03-02", period: "Custom", revenue: 200, payrollExpense: 25 },
  ]);

  assert.equal(rows[0].period, "2026-03-01");
  assert.equal(rows[0].payrollExpense, 0);
  assert.equal(rows[0].rollingRevenue, 100);
  assert.equal(rows[1].period, "Custom");
  assert.equal(rows[1].payrollExpense, 25);
  assert.equal(rows[1].rollingRevenue, 150);
});

test("buildDashboardPreviousBucketDelta and formatDashboardDeltaLabel compute comparison copy", () => {
  const delta = buildDashboardPreviousBucketDelta([
    {
      date: "2026-03-01",
      revenue: 100,
      refunds: 5,
      netRevenue: 95,
      cashIn: 50,
      cashOut: 8,
      netCash: 42,
      outstanding: 40,
    },
    {
      date: "2026-03-02",
      revenue: 140,
      refunds: 10,
      netRevenue: 130,
      cashIn: 65,
      cashOut: 5,
      netCash: 60,
      outstanding: 20,
    },
  ]);

  assert.ok(delta);
  assert.equal(delta.revenue.delta, 40);
  assert.equal(delta.refunds.delta, 5);
  assert.equal(delta.netRevenue.delta, 35);
  assert.equal(delta.cashIn.delta, 15);
  assert.equal(delta.cashOut.delta, -3);
  assert.equal(delta.netCash.delta, 18);
  assert.equal(delta.outstanding.delta, -20);
  assert.equal(
    formatDashboardDeltaLabel(delta.revenue, "day", (value) => `GH${value.toFixed(2)}`),
    "+GH40.00 (+40.0%) vs previous day",
  );
});

test("buildDashboardAnomalyChips only returns active warnings", () => {
  const chips = buildDashboardAnomalyChips({
    outstandingRatio: 0.3,
    netCash: -5,
    glRevenueDelta: 10,
    formatCurrency: (value) => `GH${value.toFixed(2)}`,
  });

  assert.deepEqual(
    chips.map((chip) => chip.key),
    ["high-outstanding", "negative-net-cash", "gl-delta"],
  );
  assert.match(chips[2].label, /GH10\.00/);
  assert.match(chips[2].label, /check unposted entries/);
});
