import test from "node:test";
import assert from "node:assert/strict";
import { createExportJob, getExportJob } from "@/lib/report-export-jobs";

test("createExportJob stores and retrieves job", () => {
  const job = createExportJob({
    id: "job-test-1",
    type: "pl_csv",
    status: "READY",
    downloadUrl: "/api/admin/accounting/reports/pl/export?start=2026-01-01&end=2026-01-31",
  });
  const loaded = getExportJob(job.id);
  assert.ok(loaded);
  assert.equal(loaded?.id, "job-test-1");
  assert.equal(loaded?.status, "READY");
});

