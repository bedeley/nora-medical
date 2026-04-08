import { describe, expect, it } from "vitest";

import { buildReportingReconciliation } from "./reporting-reconciliation";

describe("buildReportingReconciliation", () => {
  it("returns review rows when a delta exceeds tolerance", () => {
    const report = buildReportingReconciliation({
      operational: {
        totalRevenue: 100,
        netRevenue: 90,
        profit: 20,
      },
      ledger: {
        totalRevenue: 103,
        netRevenue: 90.5,
        profit: 20,
      },
    });

    expect(report).not.toBeNull();
    expect(report?.reviewCount).toBe(1);
    expect(report?.withinToleranceCount).toBe(1);
    expect(report?.alignedCount).toBe(1);
    expect(report?.rows.find((row) => row.key === "totalRevenue")?.status).toBe("review");
  });

  it("skips metrics that do not exist on both snapshots", () => {
    const report = buildReportingReconciliation({
      operational: {
        totalRevenue: 100,
        totalDiscounts: 5,
      },
      ledger: {
        totalRevenue: 100,
      },
    });

    expect(report?.rows).toHaveLength(1);
    expect(report?.rows[0]?.key).toBe("totalRevenue");
  });

  it("returns null when either side is missing", () => {
    expect(buildReportingReconciliation({ operational: null, ledger: { totalRevenue: 1 } })).toBeNull();
    expect(buildReportingReconciliation({ operational: { totalRevenue: 1 }, ledger: null })).toBeNull();
  });
});
