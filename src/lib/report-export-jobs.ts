type ExportJobStatus = "READY" | "FAILED";

export type ReportExportJob = {
  id: string;
  type: "pl_csv" | "reporting_pack_csv";
  status: ExportJobStatus;
  downloadUrl: string;
  error?: string;
  createdAt: number;
  expiresAt: number;
};

const EXPORT_JOB_TTL_MS = 15 * 60 * 1000;
const exportJobs = new Map<string, ReportExportJob>();

function cleanup() {
  const now = Date.now();
  for (const [id, job] of exportJobs.entries()) {
    if (job.expiresAt <= now) exportJobs.delete(id);
  }
}

export function createExportJob(input: Omit<ReportExportJob, "createdAt" | "expiresAt">) {
  cleanup();
  const now = Date.now();
  const job: ReportExportJob = {
    ...input,
    createdAt: now,
    expiresAt: now + EXPORT_JOB_TTL_MS,
  };
  exportJobs.set(job.id, job);
  return job;
}

export function getExportJob(id: string) {
  cleanup();
  return exportJobs.get(id) || null;
}

