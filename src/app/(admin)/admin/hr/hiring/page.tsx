"use client";

export const dynamic = "force-dynamic";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  BriefcaseBusiness,
  ClipboardList,
  FileSearch,
  MoreHorizontal,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  buildInterviewNotes,
  formatUtcIsoToLocalInput,
  parseLocalDateTimeToUtcIso,
  parseInterviewFromNotes,
  type HiringInterviewMeta,
} from "@/lib/hr-hiring-interview-meta";
import { validateApplicationStageTransition } from "@/lib/hr-hiring-utils";

type JobPosting = {
  id: string;
  title: string;
  department?: string | null;
  location?: string | null;
  status: "OPEN" | "PAUSED" | "CLOSED";
  description?: string | null;
  requirements?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  openedAt: string;
  closedAt?: string | null;
  updatedAt?: string;
};

type Applicant = {
  id: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  source?: string | null;
  resumeUrl?: string | null;
  updatedAt?: string;
};

type Application = {
  id: string;
  stage: "APPLIED" | "SCREENING" | "INTERVIEW" | "OFFER" | "HIRED" | "REJECTED" | "WITHDRAWN";
  notes?: string | null;
  employeeId?: string | null;
  onboarding?: {
    status: "pending" | "complete";
    summary: string;
  } | null;
  applicant: Applicant;
  jobPosting: JobPosting;
  createdAt: string;
  updatedAt?: string;
};

type ApplicationsResponse = {
  rows: Application[];
  total: number;
  lastUpdatedAt?: string | null;
  summary?: {
    total: number;
    active: number;
    applied: number;
    screening: number;
    interview: number;
    offer: number;
    hired: number;
    rejected: number;
    withdrawn: number;
  };
};

type SavedApplicationFilter = {
  id: string;
  name: string;
  search: string;
  stage: string;
  job: string;
  showHired: boolean;
};

type BulkUndoState = {
  items: Array<{ id: string; previousStage: Application["stage"] }>;
  createdAt: number;
};

type BulkSkipReason = {
  id: string;
  reason: string;
};

const fetcher = async <T,>(url: string) => {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body?.error === "string" ? body.error : "Request failed.");
  }
  return body as T;
};

const statusTone: Record<JobPosting["status"], "default" | "secondary"> = {
  OPEN: "default",
  PAUSED: "secondary",
  CLOSED: "secondary",
};
const applicationSectionId = "applications";
const applicationStageOptions: Array<{ value: Application["stage"]; label: string }> = [
  { value: "APPLIED", label: "Applied" },
  { value: "SCREENING", label: "Screening" },
  { value: "INTERVIEW", label: "Interview" },
  { value: "OFFER", label: "Offer" },
  { value: "HIRED", label: "Hired" },
  { value: "REJECTED", label: "Rejected" },
  { value: "WITHDRAWN", label: "Withdrawn" },
];
const BULK_UNDO_WINDOW_MS = 2 * 60 * 1000;

function formatStageLabel(stage: Application["stage"]) {
  return stage.charAt(0) + stage.slice(1).toLowerCase();
}

function formatDateLabel(value?: string | null, withTime = false) {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return withTime ? date.toLocaleString() : date.toLocaleDateString();
}

function getStageBadgeVariant(stage: Application["stage"]): "default" | "secondary" | "destructive" | "outline" {
  if (stage === "HIRED") return "default";
  if (stage === "REJECTED" || stage === "WITHDRAWN") return "destructive";
  if (stage === "INTERVIEW" || stage === "OFFER") return "secondary";
  return "outline";
}

function getOnboardingBadgeVariant(status?: "pending" | "complete" | null) {
  return status === "pending" ? "outline" : "secondary";
}

function SectionCardsSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((item) => (
        <div key={item} className="rounded-2xl border border-border/70 bg-background/85 p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 space-y-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-4 w-32" />
            </div>
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <div className="mt-4 flex gap-2">
            <Skeleton className="h-9 w-28" />
            <Skeleton className="h-9 w-9" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SectionTableSkeleton() {
  return (
    <div className="hidden lg:block">
      <div className="rounded-2xl border border-border/70 bg-background/85 p-4 shadow-sm">
        <div className="grid gap-3">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="grid grid-cols-4 gap-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function AdminHrHiringPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const applicationsSectionRef = useRef<HTMLDivElement | null>(null);
  const initialApplicationsSearch = searchParams.get("appQ") || "";
  const initialApplicationsStage = searchParams.get("appStage") || "all";
  const initialApplicationsJob = searchParams.get("appJob") || "all";
  const initialShowHiredApplications = searchParams.get("appShowHired") === "1";
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [jobDialogOpen, setJobDialogOpen] = useState(false);
  const [applicantDialogOpen, setApplicantDialogOpen] = useState(false);
  const [applicationDialogOpen, setApplicationDialogOpen] = useState(false);
  const [showHiredApplicants, setShowHiredApplicants] = useState(false);
  const [showHiredApplications, setShowHiredApplications] = useState(initialShowHiredApplications);
  const [importOpen, setImportOpen] = useState(false);
  const [importRows, setImportRows] = useState<Record<string, string>[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [selectedApplicationIds, setSelectedApplicationIds] = useState<string[]>([]);
  const [bulkStage, setBulkStage] = useState("SCREENING");
  const [bulkNote, setBulkNote] = useState("");
  const [bulkApplying, setBulkApplying] = useState(false);
  const [bulkConfirmDialogOpen, setBulkConfirmDialogOpen] = useState(false);
  const [compactTables, setCompactTables] = useState(false);
  const [applicantsSearch, setApplicantsSearch] = useState("");
  const [applicationsSearch, setApplicationsSearch] = useState(initialApplicationsSearch);
  const deferredApplicationsSearch = useDeferredValue(applicationsSearch);
  const [applicationsStageFilter, setApplicationsStageFilter] = useState(initialApplicationsStage);
  const [applicationsJobFilter, setApplicationsJobFilter] = useState(initialApplicationsJob);
  const [savedApplicationFilters, setSavedApplicationFilters] = useState<SavedApplicationFilter[]>([]);
  const [selectedSavedFilterId, setSelectedSavedFilterId] = useState("none");
  const [savedFilterName, setSavedFilterName] = useState("");
  const [applicationsViewHint, setApplicationsViewHint] = useState(
    "Saved presets stay on this browser. Copy the view link when you need to share this exact filtered pipeline.",
  );
  const [lastBulkUndo, setLastBulkUndo] = useState<BulkUndoState | null>(null);
  const [undoNowTick, setUndoNowTick] = useState(Date.now());
  const [bulkSkippedDetails, setBulkSkippedDetails] = useState<BulkSkipReason[]>([]);
  const [jobCloseDialog, setJobCloseDialog] = useState<{
    open: boolean;
    jobId: string;
    reason: string;
  }>({ open: false, jobId: "", reason: "" });
  const [jobForm, setJobForm] = useState({
    title: "",
    department: "",
    location: "",
    status: "OPEN",
    description: "",
    requirements: "",
    salaryMin: "",
    salaryMax: "",
    openedAt: "",
  });
  const [editingJob, setEditingJob] = useState<JobPosting | null>(null);
  const [jobEditDialogOpen, setJobEditDialogOpen] = useState(false);
  const [applicantForm, setApplicantForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    source: "",
    resumeUrl: "",
  });
  const [editingApplicant, setEditingApplicant] = useState<Applicant | null>(null);
  const [applicantEditDialogOpen, setApplicantEditDialogOpen] = useState(false);
  const [applicationForm, setApplicationForm] = useState({
    applicantId: "",
    jobPostingId: "",
    stage: "APPLIED",
    notes: "",
  });
  const [applicationDetailDialog, setApplicationDetailDialog] = useState<{
    open: boolean;
    applicationId: string;
  }>({
    open: false,
    applicationId: "",
  });
  const [decisionDialog, setDecisionDialog] = useState<{
    open: boolean;
    applicationId: string;
    stage: Application["stage"] | "";
    note: string;
  }>({
    open: false,
    applicationId: "",
    stage: "",
    note: "",
  });
  const [interviewDialog, setInterviewDialog] = useState<{
    open: boolean;
    applicationId: string;
    scheduledAt: string;
    interviewer: string;
    outcome: string;
    note: string;
  }>({
    open: false,
    applicationId: "",
    scheduledAt: "",
    interviewer: "",
    outcome: "",
    note: "",
  });
  const sourcePage = "admin/hr/hiring";
  const openOnboardingForEmployee = (input: { employeeId?: string | null; applicationId?: string | null }) => {
    const targetEmployeeId = String(input.employeeId || "").trim();
    if (!targetEmployeeId) return false;
    const params = new URLSearchParams({
      employeeId: targetEmployeeId,
      source: "hiring",
    });
    const applicationId = String(input.applicationId || "").trim();
    if (applicationId) params.set("applicationId", applicationId);
    router.push(`/admin/hr/onboarding?${params.toString()}`);
    return true;
  };
  const savePresetButtonRef = useRef<HTMLButtonElement | null>(null);
  const applyBulkButtonRef = useRef<HTMLButtonElement | null>(null);
  const tableDensityClass = compactTables
    ? "[&_thead_th]:py-1 [&_tbody_td]:py-1 [&_thead_th]:text-xs [&_tbody_td]:text-xs"
    : "";

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("hrHiringSavedApplicationFilters");
      if (!raw) return;
      const parsed = JSON.parse(raw) as SavedApplicationFilter[];
      if (Array.isArray(parsed)) {
        setSavedApplicationFilters(
          parsed
            .filter((row) => row && typeof row === "object")
            .slice(0, 10)
            .map((row) => ({
              id: String(row.id || ""),
              name: String(row.name || "Saved filter"),
              search: String(row.search || ""),
              stage: String(row.stage || "all"),
              job: String(row.job || "all"),
              showHired: Boolean(row.showHired),
            }))
            .filter((row) => row.id.length > 0),
        );
      }
    } catch {
      // Ignore invalid local storage payload.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "hrHiringSavedApplicationFilters",
        JSON.stringify(savedApplicationFilters.slice(0, 10)),
      );
    } catch {
      // Ignore storage write issues.
    }
  }, [savedApplicationFilters]);

  useEffect(() => {
    const nextSearch = searchParams.get("appQ") || "";
    const nextStage = searchParams.get("appStage") || "all";
    const nextJob = searchParams.get("appJob") || "all";
    const nextShowHired = searchParams.get("appShowHired") === "1";
    setApplicationsSearch((current) => (current === nextSearch ? current : nextSearch));
    setApplicationsStageFilter((current) => (current === nextStage ? current : nextStage));
    setApplicationsJobFilter((current) => (current === nextJob ? current : nextJob));
    setShowHiredApplications((current) => (current === nextShowHired ? current : nextShowHired));
  }, [searchParams]);

  useEffect(() => {
    const currentSearch = searchParams.get("appQ") || "";
    const currentStage = searchParams.get("appStage") || "all";
    const currentJob = searchParams.get("appJob") || "all";
    const currentShowHired = searchParams.get("appShowHired") === "1";
    if (
      currentSearch === deferredApplicationsSearch &&
      currentStage === applicationsStageFilter &&
      currentJob === applicationsJobFilter &&
      currentShowHired === showHiredApplications
    ) {
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    if (deferredApplicationsSearch.trim()) params.set("appQ", deferredApplicationsSearch.trim());
    else params.delete("appQ");
    if (applicationsStageFilter !== "all") params.set("appStage", applicationsStageFilter);
    else params.delete("appStage");
    if (applicationsJobFilter !== "all") params.set("appJob", applicationsJobFilter);
    else params.delete("appJob");
    if (showHiredApplications) params.set("appShowHired", "1");
    else params.delete("appShowHired");
    const href = params.size ? `${pathname}?${params.toString()}` : pathname;
    router.replace(href, { scroll: false });
  }, [
    applicationsJobFilter,
    applicationsStageFilter,
    deferredApplicationsSearch,
    pathname,
    router,
    searchParams,
    showHiredApplications,
  ]);

  useEffect(() => {
    if (!lastBulkUndo) return;
    const timer = window.setInterval(() => {
      setUndoNowTick(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [lastBulkUndo]);

  useEffect(() => {
    if (!lastBulkUndo) return;
    if (Date.now() - lastBulkUndo.createdAt >= BULK_UNDO_WINDOW_MS) {
      setLastBulkUndo(null);
    }
  }, [lastBulkUndo, undoNowTick]);

  const parseCsv = (text: string) => {
    const rows: string[][] = [];
    let current = "";
    let inQuotes = false;
    let row: string[] = [];
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const next = text[i + 1];
      if (char === "\"") {
        if (inQuotes && next === "\"") {
          current += "\"";
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (char === "," && !inQuotes) {
        row.push(current.trim());
        current = "";
        continue;
      }
      if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && next === "\n") i += 1;
        row.push(current.trim());
        if (row.some((cell) => cell.length > 0)) rows.push(row);
        row = [];
        current = "";
        continue;
      }
      current += char;
    }
    if (current.length > 0 || row.length > 0) {
      row.push(current.trim());
      if (row.some((cell) => cell.length > 0)) rows.push(row);
    }
    return rows;
  };

  const handleImportFile = async (file?: File | null) => {
    if (!file) return;
    const text = await file.text();
    const rows = parseCsv(text);
    const [headerRow, ...dataRows] = rows;
    if (!headerRow) {
      setImportErrors(["CSV has no header row."]);
      setImportRows([]);
      return;
    }
    const headers = headerRow.map((h) => h.trim().toLowerCase());
    const mappedRows: Record<string, string>[] = [];
    const errors: string[] = [];
    dataRows.forEach((row, index) => {
      const entry: Record<string, string> = {};
      headers.forEach((key, idx) => {
        entry[key] = row[idx] ?? "";
      });
      if (!entry.firstname || !entry.lastname) {
        errors.push(`Row ${index + 2}: firstName and lastName are required.`);
      }
      mappedRows.push(entry);
    });
    setImportRows(mappedRows);
    setImportErrors(errors);
  };

  const handleImportSubmit = async () => {
    if (importRows.length === 0) {
      toast.error("No rows to import.");
      return;
    }
    if (importErrors.length > 0) {
      toast.error("Fix CSV errors before importing.");
      return;
    }
    setImporting(true);
    try {
      const res = await fetch("/api/admin/hr/applicants/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: importRows,
          sourcePage,
          section: "applicants",
          operation: "import_applicants_csv",
          resultSummary: "Applicants imported from hiring page CSV upload.",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to import applicants.");
        return;
      }
      toast.success(`Imported ${body.created} applicant(s).`);
      if (body.skipped) {
        toast.success(`Skipped ${body.skipped} existing record(s).`);
      }
      if (Array.isArray(body.errors) && body.errors.length > 0) {
        toast.error(`Some rows failed: ${body.errors.length}.`);
      }
      setImportOpen(false);
      setImportRows([]);
      setImportErrors([]);
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "applicants"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to import applicants.");
    } finally {
      setImporting(false);
    }
  };

  const downloadTemplate = () => {
    const header = "firstName,lastName,email,phone,source,resumeUrl";
    const sample = "Kofi,Mensah,kofi@example.com,0240000000,Referral,https://example.com/cv.pdf";
    const csv = `${header}\n${sample}\n`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "applicant-import-template.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  };

  const downloadCsv = (filename: string, headers: string[], rows: string[][]) => {
    const timestamp = (() => {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");
      const hours = String(now.getHours()).padStart(2, "0");
      const minutes = String(now.getMinutes()).padStart(2, "0");
      const seconds = String(now.getSeconds()).padStart(2, "0");
      return `${year}${month}${day}-${hours}${minutes}${seconds}`;
    })();
    const timestampedFilename = filename.endsWith(".csv")
      ? `${filename.slice(0, -4)}-${timestamp}.csv`
      : `${filename}-${timestamp}`;
    const escapeCsv = (value: string) => {
      const text = String(value ?? "");
      if (text.includes(",") || text.includes('"') || text.includes("\n")) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    };
    const csv = [headers, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = timestampedFilename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  };

  const downloadServerCsv = (path: string, query: Record<string, string>) => {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (!value) return;
      params.set(key, value);
    });
    const href = `${path}?${params.toString()}`;
    const link = document.createElement("a");
    link.href = href;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const downloadImportErrors = () => {
    if (importErrors.length === 0) return;
    const rows = importErrors.map((error) => [error]);
    downloadCsv("applicant-import-errors.csv", ["error"], rows);
  };

  const jobsQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (status !== "all") params.set("status", status);
    return `/api/admin/hr/jobs?${params.toString()}`;
  }, [search, status]);

  const {
    data: jobsData,
    isLoading: jobsLoading,
    isFetching: jobsFetching,
  } = useQuery({
    queryKey: ["admin", "hr", "jobs", search, status],
    queryFn: () => fetcher<{ rows: JobPosting[] }>(jobsQuery),
  });
  const {
    data: applicantsData,
    isLoading: applicantsLoading,
    isFetching: applicantsFetching,
  } = useQuery({
    queryKey: ["admin", "hr", "applicants", applicantsSearch, showHiredApplicants],
    queryFn: () =>
      fetcher<{ rows: Applicant[] }>(
        `/api/admin/hr/applicants?${new URLSearchParams({
          includeHired: showHiredApplicants ? "1" : "0",
          ...(applicantsSearch.trim() ? { q: applicantsSearch.trim() } : {}),
        }).toString()}`,
      ),
  });
  const applicationsQueryKey = [
    "admin",
    "hr",
    "applications",
    deferredApplicationsSearch,
    applicationsStageFilter,
    applicationsJobFilter,
    showHiredApplications,
  ] as const;
  const {
    data: applicationsData,
    isLoading: applicationsLoading,
    isFetching: applicationsFetching,
  } = useQuery({
    queryKey: applicationsQueryKey,
    queryFn: () =>
      fetcher<ApplicationsResponse>(
        `/api/admin/hr/applications?${new URLSearchParams({
          ...(deferredApplicationsSearch.trim() ? { q: deferredApplicationsSearch.trim() } : {}),
          ...(applicationsStageFilter !== "all" ? { stage: applicationsStageFilter } : {}),
          ...(applicationsJobFilter !== "all" ? { jobPostingId: applicationsJobFilter } : {}),
          ...(showHiredApplications ? { showHired: "1" } : {}),
        }).toString()}`,
      ),
  });

  const jobs = useMemo(
    () => (Array.isArray(jobsData?.rows) ? (jobsData.rows as JobPosting[]) : []),
    [jobsData],
  );
  const applicants = useMemo(
    () => (Array.isArray(applicantsData?.rows) ? (applicantsData.rows as Applicant[]) : []),
    [applicantsData],
  );
  const applications = useMemo(
    () => (Array.isArray(applicationsData?.rows) ? (applicationsData.rows as Application[]) : []),
    [applicationsData],
  );
  const applicationsSummary = applicationsData?.summary;
  const applicationsTotal = Number(applicationsData?.total || 0);
  const visibleApplicants = applicants;
  const visibleApplications = applications;
  const hiringKpis = useMemo(() => {
    const openJobs = jobs.filter((row) => row.status === "OPEN").length;
    return {
      openJobs,
      pipelineActive: Number(applicationsSummary?.active || 0),
      interviews: Number(applicationsSummary?.interview || 0),
      offers: Number(applicationsSummary?.offer || 0),
    };
  }, [applicationsSummary, jobs]);
  const pipelineInsights = useMemo(() => {
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    let stalledInterviews = 0;
    let recentActivity = 0;

    applications.forEach((row) => {
      const lastChangedAt = new Date(row.updatedAt || row.createdAt).getTime();
      if (Number.isFinite(lastChangedAt) && now - lastChangedAt <= sevenDaysMs) {
        recentActivity += 1;
      }

      if (row.stage !== "INTERVIEW") return;
      const parsed = parseInterviewFromNotes(row.notes);
      const scheduledAt = parsed.meta?.scheduledAt ? new Date(String(parsed.meta.scheduledAt)).getTime() : NaN;
      if (Number.isFinite(scheduledAt) && scheduledAt < now) {
        stalledInterviews += 1;
      }
    });

    return {
      stalledInterviews,
      recentActivity,
    };
  }, [applications]);
  const applicationJobs = useMemo(
    () => Array.from(new Map(jobs.map((row) => [row.id, row.title])).entries()),
    [jobs],
  );
  const applicationNameById = useMemo(
    () =>
      new Map(
        applications.map((row) => [
          row.id,
          `${row.applicant.firstName} ${row.applicant.lastName}`.trim(),
        ]),
      ),
    [applications],
  );
  const applicationsLastUpdatedText = useMemo(
    () => formatDateLabel(applicationsData?.lastUpdatedAt, true),
    [applicationsData?.lastUpdatedAt],
  );
  const undoRemainingSeconds = lastBulkUndo
    ? Math.max(0, Math.ceil((BULK_UNDO_WINDOW_MS - (undoNowTick - lastBulkUndo.createdAt)) / 1000))
    : 0;

  const handleSaveApplicationsFilter = () => {
    const name = savedFilterName.trim();
    if (name.length < 2) {
      toast.error("Enter a short preset name.");
      return;
    }
    const record: SavedApplicationFilter = {
      id: `${Date.now()}`,
      name,
      search: applicationsSearch,
      stage: applicationsStageFilter,
      job: applicationsJobFilter,
      showHired: showHiredApplications,
    };
    setSavedApplicationFilters((prev) => [record, ...prev].slice(0, 10));
    setSelectedSavedFilterId(record.id);
    setSavedFilterName("");
    setApplicationsViewHint(`Saved "${record.name}" on this browser.`);
    toast.success("Saved this view on this browser.");
  };

  const handleApplySavedApplicationsFilter = (id: string) => {
    setSelectedSavedFilterId(id);
    if (id === "none") return;
    const selected = savedApplicationFilters.find((row) => row.id === id);
    if (!selected) {
      toast.error("Saved filter not found.");
      return;
    }
    applyApplicationView({
      search: selected.search,
      stage: selected.stage,
      job: selected.job,
      showHired: selected.showHired,
      scroll: true,
    });
    setApplicationsViewHint(`Applied "${selected.name}".`);
    toast.success("Saved view applied.");
  };

  const handleDeleteSavedApplicationsFilter = () => {
    if (selectedSavedFilterId === "none") return;
    const removed = savedApplicationFilters.find((row) => row.id === selectedSavedFilterId);
    setSavedApplicationFilters((prev) => prev.filter((row) => row.id !== selectedSavedFilterId));
    setSelectedSavedFilterId("none");
    setApplicationsViewHint(
      removed ? `Removed "${removed.name}" from this browser.` : "Removed the saved view from this browser.",
    );
    toast.success("Saved view removed.");
  };

  const scrollToApplicationsSection = () => {
    window.requestAnimationFrame(() => {
      applicationsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const applyApplicationView = (next: {
    search?: string;
    stage?: string;
    job?: string;
    showHired?: boolean;
    scroll?: boolean;
  }) => {
    if (typeof next.search === "string") setApplicationsSearch(next.search);
    if (typeof next.stage === "string") setApplicationsStageFilter(next.stage);
    if (typeof next.job === "string") setApplicationsJobFilter(next.job);
    if (typeof next.showHired === "boolean") setShowHiredApplications(next.showHired);
    if (next.scroll) scrollToApplicationsSection();
  };

  const resetApplicationFilters = () => {
    applyApplicationView({
      search: "",
      stage: "all",
      job: "all",
      showHired: false,
    });
    setSelectedSavedFilterId("none");
  };

  const toggleApplicationSelection = (id: string, checked: boolean) => {
    setSelectedApplicationIds((prev) => {
      if (checked) {
        if (prev.includes(id)) return prev;
        return [...prev, id];
      }
      return prev.filter((value) => value !== id);
    });
  };

  useEffect(() => {
    const visibleIds = new Set(visibleApplications.map((row) => row.id));
    setSelectedApplicationIds((prev) => prev.filter((id) => visibleIds.has(id)));
  }, [visibleApplications]);

  const toggleSelectAllVisible = (checked: boolean) => {
    if (checked) {
      setSelectedApplicationIds(visibleApplications.map((row) => row.id));
      return;
    }
    setSelectedApplicationIds([]);
  };

  const emptyJobForm = {
    title: "",
    department: "",
    location: "",
    status: "OPEN",
    description: "",
    requirements: "",
    salaryMin: "",
    salaryMax: "",
    openedAt: "",
  };

  const emptyApplicantForm = {
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    source: "",
    resumeUrl: "",
  };

  const handleOpenJobEdit = (job: JobPosting) => {
    setEditingJob(job);
    setJobForm({
      title: job.title || "",
      department: job.department || "",
      location: job.location || "",
      status: job.status,
      description: job.description || "",
      requirements: job.requirements || "",
      salaryMin: typeof job.salaryMin === "number" ? String(job.salaryMin) : "",
      salaryMax: typeof job.salaryMax === "number" ? String(job.salaryMax) : "",
      openedAt: formatUtcIsoToLocalInput(job.openedAt),
    });
    setJobEditDialogOpen(true);
  };

  const handleOpenApplicantEdit = (applicant: Applicant) => {
    setEditingApplicant(applicant);
    setApplicantForm({
      firstName: applicant.firstName || "",
      lastName: applicant.lastName || "",
      email: applicant.email || "",
      phone: applicant.phone || "",
      source: applicant.source || "",
      resumeUrl: applicant.resumeUrl || "",
    });
    setApplicantEditDialogOpen(true);
  };

  const handleOpenApplicationDetail = (applicationId: string) => {
    setApplicationDetailDialog({
      open: true,
      applicationId,
    });
  };

  const handleOpenDecisionDialog = (
    applicationId: string,
    stage: Extract<Application["stage"], "REJECTED" | "WITHDRAWN">,
  ) => {
    setDecisionDialog({
      open: true,
      applicationId,
      stage,
      note: "",
    });
  };

  const handleCreateJob = async () => {
    if (!jobForm.title.trim()) {
      toast.error("Job title is required.");
      return;
    }
    const openedAtParse = jobForm.openedAt ? parseLocalDateTimeToUtcIso(jobForm.openedAt) : { ok: true, iso: "" } as const;
    if (!openedAtParse.ok) {
      toast.error(openedAtParse.error);
      return;
    }
    try {
      const res = await fetch("/api/admin/hr/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...jobForm,
          salaryMin: jobForm.salaryMin ? Number(jobForm.salaryMin) : undefined,
          salaryMax: jobForm.salaryMax ? Number(jobForm.salaryMax) : undefined,
          openedAt: openedAtParse.iso,
          sourcePage,
          section: "job-postings",
          operation: "create_job_posting",
          resultSummary: "Created a job posting from the hiring page.",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to create job posting.");
        return;
      }
      toast.success("Job posting created.");
      setJobDialogOpen(false);
      setJobForm(emptyJobForm);
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "jobs"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to create job posting.");
    }
  };

  const handleCreateApplicant = async () => {
    if (!applicantForm.firstName.trim() || !applicantForm.lastName.trim()) {
      toast.error("First name and last name are required.");
      return;
    }
    try {
      const res = await fetch("/api/admin/hr/applicants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...applicantForm,
          sourcePage,
          section: "applicants",
          operation: "create_applicant",
          resultSummary: "Added an applicant from the hiring page.",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to add applicant.");
        return;
      }
      toast.success("Applicant added.");
      setApplicantDialogOpen(false);
      setApplicantForm(emptyApplicantForm);
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "applicants"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to add applicant.");
    }
  };

  const handleSaveJobEdit = async () => {
    if (!editingJob) return;
    if (!jobForm.title.trim()) {
      toast.error("Job title is required.");
      return;
    }
    const openedAtParse = jobForm.openedAt ? parseLocalDateTimeToUtcIso(jobForm.openedAt) : { ok: true, iso: "" } as const;
    if (!openedAtParse.ok) {
      toast.error(openedAtParse.error);
      return;
    }
    try {
      const res = await fetch(`/api/admin/hr/jobs/${editingJob.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: jobForm.title,
          department: jobForm.department,
          location: jobForm.location,
          status: jobForm.status,
          description: jobForm.description,
          requirements: jobForm.requirements,
          salaryMin: jobForm.salaryMin ? Number(jobForm.salaryMin) : undefined,
          salaryMax: jobForm.salaryMax ? Number(jobForm.salaryMax) : undefined,
          openedAt: openedAtParse.iso,
          expectedUpdatedAt: editingJob.updatedAt || "",
          sourcePage,
          section: "job-postings",
          operation: "update_job_posting",
          resultSummary: "Updated job posting details from the hiring page.",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to update job posting.");
        return;
      }
      toast.success("Job posting updated.");
      setJobEditDialogOpen(false);
      setEditingJob(null);
      setJobForm(emptyJobForm);
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "jobs"] });
    } catch {
      toast.error("Failed to update job posting.");
    }
  };

  const handleSaveApplicantEdit = async () => {
    if (!editingApplicant) return;
    if (!applicantForm.firstName.trim() || !applicantForm.lastName.trim()) {
      toast.error("First name and last name are required.");
      return;
    }
    try {
      const res = await fetch(`/api/admin/hr/applicants/${editingApplicant.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...applicantForm,
          expectedUpdatedAt: editingApplicant.updatedAt || "",
          sourcePage,
          section: "applicants",
          operation: "update_applicant",
          resultSummary: "Updated applicant details from the hiring page.",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to update applicant.");
        return;
      }
      toast.success("Applicant updated.");
      setApplicantEditDialogOpen(false);
      setEditingApplicant(null);
      setApplicantForm(emptyApplicantForm);
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "applicants"] });
    } catch {
      toast.error("Failed to update applicant.");
    }
  };

  const handleCopyCurrentApplicationView = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setApplicationsViewHint("Shareable view link copied.");
      toast.success("Shareable view link copied.");
    } catch {
      toast.error("Could not copy the current view link.");
    }
  };

  const handleCreateApplication = async () => {
    if (!applicationForm.applicantId || !applicationForm.jobPostingId) {
      toast.error("Select both applicant and job posting.");
      return;
    }
    if (
      (applicationForm.stage === "REJECTED" || applicationForm.stage === "WITHDRAWN") &&
      applicationForm.notes.trim().length < 3
    ) {
      toast.error("Add a short note for rejected or withdrawn applications.");
      return;
    }
    try {
      const res = await fetch("/api/admin/hr/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...applicationForm,
          sourcePage,
          section: "applications",
          operation: "create_application",
          resultSummary: "Created an application from the hiring page.",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to create application.");
        return;
      }
      toast.success("Application created.");
      if (body.employeeAction === "created") {
        toast.success("Employee created from hire.");
      } else if (body.employeeAction === "reactivated") {
        toast.success("Employee reactivated from hire.");
      }
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "applications"] });
      if (body.employeeAction && openOnboardingForEmployee({ employeeId: body.employeeId, applicationId: body.id })) {
        toast.success("Opening centralized employee onboarding.");
        setApplicationDialogOpen(false);
        setApplicationForm({ applicantId: "", jobPostingId: "", stage: "APPLIED", notes: "" });
        return;
      }
      setApplicationDialogOpen(false);
      setApplicationForm({ applicantId: "", jobPostingId: "", stage: "APPLIED", notes: "" });
    } catch (err) {
      console.error(err);
      toast.error("Failed to create application.");
    }
  };

  const handleJobStatusUpdate = async (
    job: JobPosting,
    nextStatus: JobPosting["status"],
    closeReason = "",
  ) => {
    try {
      const res = await fetch(`/api/admin/hr/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: nextStatus,
          expectedUpdatedAt: job.updatedAt || "",
          sourcePage,
          section: "job-postings",
          operation: "update_job_status",
          resultSummary:
            closeReason.trim().length > 0
              ? `Updated the job posting status. Reason: ${closeReason.trim()}`
              : "Updated the job posting status from the hiring page.",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to update job status.");
        return;
      }
      toast.success("Job status updated.");
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "jobs"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to update job status.");
    }
  };

  const handleApplicationStageUpdate = async (
    applicationId: string,
    nextStage: Application["stage"],
    expectedUpdatedAt: string,
    decisionNote = "",
  ) => {
    try {
      const res = await fetch(`/api/admin/hr/applications/${applicationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage: nextStage,
          notes: decisionNote,
          expectedUpdatedAt,
          sourcePage,
          section: "applications",
          operation: "update_application_stage",
          resultSummary:
            decisionNote.trim().length > 0
              ? `Updated the application stage. Note: ${decisionNote.trim()}`
              : "Updated the application stage from the hiring page.",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to update stage.");
        return;
      }
      toast.success("Application stage updated.");
      if (body.employeeAction === "created") {
        toast.success("Employee created from hire.");
      } else if (body.employeeAction === "reactivated") {
        toast.success("Employee reactivated from hire.");
      }
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "applications"] });
      if (body.employeeAction && openOnboardingForEmployee({ employeeId: body.employeeId, applicationId })) {
        toast.success("Opening centralized employee onboarding.");
      }
    } catch (err) {
      console.error(err);
      toast.error("Failed to update stage.");
    }
  };

  const runBulkStageApply = async () => {
    if (selectedApplicationIds.length === 0) {
      toast.error("Select at least one application.");
      return;
    }
    if ((bulkStage === "REJECTED" || bulkStage === "WITHDRAWN") && bulkNote.trim().length < 3) {
      toast.error("Add a short note for rejected or withdrawn bulk updates.");
      return;
    }
    setBulkSkippedDetails([]);
    setBulkApplying(true);
    const optimisticChangedAt = new Date().toISOString();
    const applicationsSnapshot = queryClient.getQueryData<ApplicationsResponse>(applicationsQueryKey);
    const snapshotRows = Array.isArray(applicationsSnapshot?.rows) ? applicationsSnapshot.rows : [];
    const expectedUpdatedAtById = Object.fromEntries(
      snapshotRows
        .filter((row) => selectedApplicationIds.includes(row.id))
        .map((row) => [row.id, String(row.updatedAt || "")]),
    );
    const selectedIds = [...selectedApplicationIds];
    const targetStage = bulkStage as Application["stage"];
    queryClient.setQueryData<ApplicationsResponse>(applicationsQueryKey, (prev) => {
      if (!prev || !Array.isArray(prev.rows)) return prev;
      return {
        ...prev,
        rows: prev.rows.map((row) =>
          selectedIds.includes(row.id) ? { ...row, stage: targetStage, updatedAt: optimisticChangedAt } : row,
        ),
      };
    });
    try {
      const res = await fetch("/api/admin/hr/applications/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: selectedApplicationIds,
          stage: bulkStage,
          notes: bulkNote,
          expectedUpdatedAtById,
          sourcePage,
          section: "applications",
          operation: "bulk_update_application_stage",
          resultSummary: "Ran a bulk application stage update from the hiring page.",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        queryClient.setQueryData(applicationsQueryKey, applicationsSnapshot);
        toast.error(body.error || "Bulk update failed.");
        return;
      }
      const skippedIds = Array.isArray(body.skipped)
        ? (body.skipped as Array<{ id?: string }>).map((row) => String(row.id || ""))
        : [];
      const skippedDetails = Array.isArray(body.skipped)
        ? (body.skipped as Array<{ id?: string; reason?: string }>)
            .map((row) => ({
              id: String(row.id || ""),
              reason: String(row.reason || "Skipped."),
            }))
            .filter((row) => row.id.length > 0)
        : [];
      const updatedIds = Array.isArray(body.updated)
        ? (body.updated as Array<{ id?: string }>).map((row) => String(row.id || ""))
        : [];
      const undoItems = Array.isArray(body.updated)
        ? (body.updated as Array<{ id?: string; from?: string }>)
            .map((row) => {
              const id = String(row.id || "");
              const from = String(row.from || "") as Application["stage"];
              if (!id || !from) return null;
              return { id, previousStage: from };
            })
            .filter((row): row is { id: string; previousStage: Application["stage"] } => row !== null)
        : [];
      queryClient.setQueryData<ApplicationsResponse>(applicationsQueryKey, (prev) => {
        if (!prev || !Array.isArray(prev.rows)) return prev;
        const snapshotById = new Map(snapshotRows.map((row) => [row.id, row]));
        return {
          ...prev,
          rows: prev.rows.map((row) => {
            if (updatedIds.includes(row.id)) return { ...row, stage: targetStage, updatedAt: optimisticChangedAt };
            if (skippedIds.includes(row.id)) return snapshotById.get(row.id) ?? row;
            return row;
          }),
        };
      });
      toast.success(`Updated ${Number(body.updatedCount || 0)} application(s).`);
      if (Number(body.skippedCount || 0) > 0) {
        toast.error(`Skipped ${Number(body.skippedCount || 0)} application(s).`);
        setBulkSkippedDetails(skippedDetails);
      } else {
        setBulkSkippedDetails([]);
      }
      if (undoItems.length > 0) {
        setLastBulkUndo({ items: undoItems, createdAt: Date.now() });
      }
      setSelectedApplicationIds([]);
      setBulkNote("");
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "applications"] });
    } catch {
      queryClient.setQueryData(applicationsQueryKey, applicationsSnapshot);
      toast.error("Bulk update failed.");
    } finally {
      setBulkApplying(false);
    }
  };

  const handleBulkStageApply = () => {
    if (selectedApplicationIds.length === 0) {
      toast.error("Select at least one application.");
      return;
    }
    if ((bulkStage === "REJECTED" || bulkStage === "WITHDRAWN") && bulkNote.trim().length < 3) {
      toast.error("Add a short note for rejected or withdrawn bulk updates.");
      return;
    }
    if (bulkStage === "HIRED" || bulkStage === "REJECTED" || bulkStage === "WITHDRAWN") {
      setBulkConfirmDialogOpen(true);
      return;
    }
    void runBulkStageApply();
  };

  const handleUndoLastBulkUpdate = async () => {
    if (!lastBulkUndo || lastBulkUndo.items.length === 0) {
      toast.error("No bulk update to undo.");
      return;
    }
    setBulkApplying(true);
    try {
      const liveRows = applications;
      const liveById = new Map(liveRows.map((row) => [row.id, row]));
      const grouped = new Map<Application["stage"], string[]>();
      for (const item of lastBulkUndo.items) {
        const current = liveById.get(item.id);
        if (!current) continue;
        const list = grouped.get(item.previousStage) || [];
        list.push(item.id);
        grouped.set(item.previousStage, list);
      }
      let totalUpdated = 0;
      let totalSkipped = 0;
      for (const [targetStage, ids] of grouped.entries()) {
        if (ids.length === 0) continue;
        const expectedMap = Object.fromEntries(
          ids.map((id) => [id, String(liveById.get(id)?.updatedAt || "")]),
        );
        const res = await fetch("/api/admin/hr/applications/bulk", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ids,
            stage: targetStage,
            notes: "Undo previous bulk stage update.",
            expectedUpdatedAtById: expectedMap,
            sourcePage,
            section: "applications",
            operation: "undo_bulk_update_application_stage",
            resultSummary: "Undid the previous bulk application update from the hiring page.",
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(body.error || "Undo bulk update failed.");
          continue;
        }
        totalUpdated += Number(body.updatedCount || 0);
        totalSkipped += Number(body.skippedCount || 0);
      }
      if (totalUpdated > 0) {
        toast.success(`Undo completed for ${totalUpdated} application(s).`);
      }
      if (totalSkipped > 0) {
        toast.error(`Undo skipped ${totalSkipped} application(s).`);
      }
      setLastBulkUndo(null);
      setBulkSkippedDetails([]);
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "applications"] });
    } catch {
      toast.error("Undo bulk update failed.");
    } finally {
      setBulkApplying(false);
    }
  };

  const openInterviewPlanner = (application: Application) => {
    const parsed = parseInterviewFromNotes(application.notes);
    setInterviewDialog({
      open: true,
      applicationId: application.id,
      scheduledAt: formatUtcIsoToLocalInput(parsed.meta?.scheduledAt),
      interviewer: String(parsed.meta?.interviewer || ""),
      outcome: String(parsed.meta?.outcome || ""),
      note: parsed.plain,
    });
  };

  const handleSaveInterviewPlan = async () => {
    if (!interviewDialog.applicationId) return;
    const application = applications.find((row) => row.id === interviewDialog.applicationId);
    if (!application) {
      toast.error("Application not found.");
      return;
    }
    const scheduleParse = parseLocalDateTimeToUtcIso(interviewDialog.scheduledAt);
    if (!scheduleParse.ok) {
      toast.error(scheduleParse.error);
      return;
    }
    const meta: HiringInterviewMeta = {
      scheduledAt: scheduleParse.iso,
      interviewer: interviewDialog.interviewer.trim() || null,
      outcome: interviewDialog.outcome.trim() || null,
    };
    const notes = buildInterviewNotes(interviewDialog.note, meta);
    try {
      const res = await fetch(`/api/admin/hr/applications/${application.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notes,
          expectedUpdatedAt: application.updatedAt || "",
          sourcePage,
          section: "applications",
          operation: "update_interview_plan",
          resultSummary: "Updated the interview plan from the hiring page.",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to update interview plan.");
        return;
      }
      toast.success("Interview plan updated.");
      setInterviewDialog({
        open: false,
        applicationId: "",
        scheduledAt: "",
        interviewer: "",
        outcome: "",
        note: "",
      });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "applications"] });
    } catch {
      toast.error("Failed to update interview plan.");
    }
  };

  const selectedApplicationDetail = useMemo(
    () => applications.find((row) => row.id === applicationDetailDialog.applicationId) || null,
    [applicationDetailDialog.applicationId, applications],
  );
  const selectedApplicationInterview = useMemo(
    () => parseInterviewFromNotes(selectedApplicationDetail?.notes),
    [selectedApplicationDetail?.notes],
  );

  const getApplicationActionOptions = (application: Application) =>
    applicationStageOptions.filter((stage) => {
      if (stage.value === application.stage) return false;
      return validateApplicationStageTransition(application.stage, stage.value).ok;
    });

  const handleApplicationAction = (
    application: Application,
    nextStage: Application["stage"],
  ) => {
    if (nextStage === "REJECTED" || nextStage === "WITHDRAWN") {
      handleOpenDecisionDialog(application.id, nextStage);
      return;
    }
    void handleApplicationStageUpdate(application.id, nextStage, application.updatedAt || "");
  };

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName.toLowerCase();
      return (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        Boolean(target.closest("[contenteditable='true']"))
      );
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      if (isTypingTarget(event.target)) return;

      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        savePresetButtonRef.current?.click();
        return;
      }
      if (key === "b") {
        event.preventDefault();
        applyBulkButtonRef.current?.click();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const hasActiveApplicationFilters =
    deferredApplicationsSearch.trim().length > 0 ||
    applicationsStageFilter !== "all" ||
    applicationsJobFilter !== "all" ||
    showHiredApplications;
  const matchingApplicationsLabel =
    applicationsTotal === 1 ? "1 application matches this view." : `${applicationsTotal} applications match this view.`;

  return (
    <section className="space-y-6 pb-16">
      <Card className="overflow-hidden border-border/70 bg-gradient-to-br from-background via-primary/5 to-background">
        <CardContent className="space-y-6 p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="max-w-3xl space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.28em] text-muted-foreground">
                <Badge variant="outline">Talent operations</Badge>
                <span>HR hiring workspace</span>
              </div>
              <div className="space-y-2">
                <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Hiring Pipeline</h1>
                <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
                  Run candidate intake, job openings, interviews, and offer-stage decisions from one hiring control page.
                </p>
                <p className="text-xs text-muted-foreground">
                  {matchingApplicationsLabel}{" "}
                  {applicationsFetching
                    ? "Refreshing application activity..."
                    : `Last application activity ${applicationsLastUpdatedText.toLowerCase()}.`}
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>{pipelineInsights.stalledInterviews} interview follow-up{pipelineInsights.stalledInterviews === 1 ? "" : "s"} overdue in this view.</span>
                  <span>{pipelineInsights.recentActivity} application update{pipelineInsights.recentActivity === 1 ? "" : "s"} in the last 7 days.</span>
                  <span>Saved presets stay local. View links are shareable.</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <a
                  href="#applicants"
                  className="rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-sm font-medium text-foreground transition hover:border-primary/40 hover:bg-muted/70"
                >
                  Applicants
                </a>
                <a
                  href="#jobs"
                  className="rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-sm font-medium text-foreground transition hover:border-primary/40 hover:bg-muted/70"
                >
                  Job postings
                </a>
                <a
                  href={`#${applicationSectionId}`}
                  className="rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-sm font-medium text-foreground transition hover:border-primary/40 hover:bg-muted/70"
                >
                  Applications
                </a>
                <a
                  href="#audit"
                  className="rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-sm font-medium text-foreground transition hover:border-primary/40 hover:bg-muted/70"
                >
                  Audit
                </a>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 xl:max-w-xl xl:justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  applyApplicationView({
                    stage: "APPLIED",
                    search: "",
                    job: "all",
                    showHired: false,
                    scroll: true,
                  })
                }
              >
                <FileSearch className="mr-2 h-4 w-4" />
                New applicants
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  applyApplicationView({
                    stage: "INTERVIEW",
                    search: "",
                    job: "all",
                    showHired: false,
                    scroll: true,
                  })
                }
              >
                <ClipboardList className="mr-2 h-4 w-4" />
                Interviews
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  applyApplicationView({
                    stage: "OFFER",
                    search: "",
                    job: "all",
                    showHired: true,
                    scroll: true,
                  })
                }
              >
                <Sparkles className="mr-2 h-4 w-4" />
                Offers
              </Button>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-border/70 bg-background/85 p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="rounded-xl border border-border/70 bg-muted/60 p-2">
                  <BriefcaseBusiness className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Open roles</div>
                  <div className="text-2xl font-semibold">{hiringKpis.openJobs}</div>
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/85 p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="rounded-xl border border-border/70 bg-muted/60 p-2">
                  <UsersRound className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Active pipeline</div>
                  <div className="text-2xl font-semibold">{hiringKpis.pipelineActive}</div>
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() =>
                applyApplicationView({
                  stage: "INTERVIEW",
                  search: "",
                  job: "all",
                  showHired: false,
                  scroll: true,
                })
              }
              className="rounded-2xl border border-border/70 bg-background/85 p-4 text-left shadow-sm transition hover:border-primary/40 hover:bg-background"
            >
              <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Interview stage</div>
              <div className="mt-1 flex items-center justify-between gap-3">
                <div className="text-2xl font-semibold">{hiringKpis.interviews}</div>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </div>
            </button>
            <button
              type="button"
              onClick={() =>
                applyApplicationView({
                  stage: "OFFER",
                  search: "",
                  job: "all",
                  showHired: true,
                  scroll: true,
                })
              }
              className="rounded-2xl border border-border/70 bg-background/85 p-4 text-left shadow-sm transition hover:border-primary/40 hover:bg-background"
            >
              <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Offer stage</div>
              <div className="mt-1 flex items-center justify-between gap-3">
                <div className="text-2xl font-semibold">{hiringKpis.offers}</div>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </div>
            </button>
          </div>
        </CardContent>
      </Card>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium">Hiring actions</p>
          <p className="text-sm text-muted-foreground">
            Intake, role creation, and pipeline creation controls stay grouped here.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/admin/audit?sourcePage=admin/hr/hiring">Open hiring audit log</Link>
          </Button>
          <Dialog open={importOpen} onOpenChange={setImportOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">Import Applicants</Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>Import Applicants</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 text-sm">
                <p className="text-muted-foreground">
                  Upload a CSV with columns: firstName, lastName, email, phone, source, resumeUrl.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="secondary" onClick={downloadTemplate}>
                    Download template
                  </Button>
                  <Input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => handleImportFile(e.target.files?.[0])}
                  />
                </div>
                <div className="text-xs text-muted-foreground">
                  Rows ready: {importRows.length}. Errors: {importErrors.length}.
                </div>
                {importErrors.length > 0 ? (
                  <div className="rounded-md border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    {importErrors.slice(0, 5).map((err) => (
                      <div key={err}>{err}</div>
                    ))}
                    {importErrors.length > 5 ? <div>...</div> : null}
                  </div>
                ) : null}
                {importErrors.length > 0 ? (
                  <div>
                    <Button type="button" variant="outline" size="sm" onClick={downloadImportErrors}>
                      Download error CSV
                    </Button>
                  </div>
                ) : null}
              </div>
              <div className="flex justify-end">
                <Button onClick={handleImportSubmit} disabled={importing}>
                  {importing ? "Importing..." : "Import applicants"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          <Dialog open={jobDialogOpen} onOpenChange={setJobDialogOpen}>
            <DialogTrigger asChild>
              <Button>+ Job posting</Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>Create Job Posting</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  placeholder="Job title"
                  value={jobForm.title}
                  onChange={(e) => setJobForm((prev) => ({ ...prev, title: e.target.value }))}
                />
                <Input
                  placeholder="Department"
                  value={jobForm.department}
                  onChange={(e) => setJobForm((prev) => ({ ...prev, department: e.target.value }))}
                />
                <Select
                  value={jobForm.status}
                  onValueChange={(value) => setJobForm((prev) => ({ ...prev, status: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="OPEN">Open</SelectItem>
                    <SelectItem value="PAUSED">Paused</SelectItem>
                    <SelectItem value="CLOSED">Closed</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  placeholder="Location"
                  value={jobForm.location}
                  onChange={(e) => setJobForm((prev) => ({ ...prev, location: e.target.value }))}
                />
                <Input
                  type="datetime-local"
                  value={jobForm.openedAt}
                  onChange={(e) => setJobForm((prev) => ({ ...prev, openedAt: e.target.value }))}
                />
                <Input
                  placeholder="Salary minimum"
                  inputMode="numeric"
                  value={jobForm.salaryMin}
                  onChange={(e) => setJobForm((prev) => ({ ...prev, salaryMin: e.target.value }))}
                />
                <Input
                  placeholder="Salary maximum"
                  inputMode="numeric"
                  value={jobForm.salaryMax}
                  onChange={(e) => setJobForm((prev) => ({ ...prev, salaryMax: e.target.value }))}
                />
                <div className="sm:col-span-2">
                  <Textarea
                    placeholder="Description"
                    value={jobForm.description}
                    onChange={(e) => setJobForm((prev) => ({ ...prev, description: e.target.value }))}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Textarea
                    placeholder="Requirements"
                    value={jobForm.requirements}
                    onChange={(e) => setJobForm((prev) => ({ ...prev, requirements: e.target.value }))}
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <Button onClick={handleCreateJob}>Save job</Button>
              </div>
            </DialogContent>
          </Dialog>
          <Dialog open={applicantDialogOpen} onOpenChange={setApplicantDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">+ Applicant</Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>Add Applicant</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  placeholder="First name"
                  value={applicantForm.firstName}
                  onChange={(e) => setApplicantForm((prev) => ({ ...prev, firstName: e.target.value }))}
                />
                <Input
                  placeholder="Last name"
                  value={applicantForm.lastName}
                  onChange={(e) => setApplicantForm((prev) => ({ ...prev, lastName: e.target.value }))}
                />
                <Input
                  placeholder="Email"
                  value={applicantForm.email}
                  onChange={(e) => setApplicantForm((prev) => ({ ...prev, email: e.target.value }))}
                />
                <Input
                  placeholder="Phone"
                  value={applicantForm.phone}
                  onChange={(e) => setApplicantForm((prev) => ({ ...prev, phone: e.target.value }))}
                />
                <Input
                  placeholder="Source"
                  value={applicantForm.source}
                  onChange={(e) => setApplicantForm((prev) => ({ ...prev, source: e.target.value }))}
                />
                <Input
                  placeholder="Resume URL"
                  value={applicantForm.resumeUrl}
                  onChange={(e) => setApplicantForm((prev) => ({ ...prev, resumeUrl: e.target.value }))}
                />
              </div>
              <div className="flex justify-end">
                <Button onClick={handleCreateApplicant}>Save applicant</Button>
              </div>
            </DialogContent>
          </Dialog>
          <Dialog open={applicationDialogOpen} onOpenChange={setApplicationDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="secondary">+ Application</Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>Create Application</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={showHiredApplicants}
                    onChange={(e) => setShowHiredApplicants(e.target.checked)}
                  />
                  Show hired applicants
                </label>
                <Select
                  value={applicationForm.applicantId}
                  onValueChange={(value) => setApplicationForm((prev) => ({ ...prev, applicantId: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select applicant" />
                  </SelectTrigger>
                  <SelectContent>
                    {applicants.map((applicant) => (
                      <SelectItem key={applicant.id} value={applicant.id}>
                        {applicant.firstName} {applicant.lastName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={applicationForm.jobPostingId}
                  onValueChange={(value) => setApplicationForm((prev) => ({ ...prev, jobPostingId: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select job posting" />
                  </SelectTrigger>
                  <SelectContent>
                    {jobs.map((job) => (
                      <SelectItem key={job.id} value={job.id}>
                        {job.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={applicationForm.stage}
                  onValueChange={(value) => setApplicationForm((prev) => ({ ...prev, stage: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Stage" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="APPLIED">Applied</SelectItem>
                    <SelectItem value="SCREENING">Screening</SelectItem>
                    <SelectItem value="INTERVIEW">Interview</SelectItem>
                    <SelectItem value="OFFER">Offer</SelectItem>
                    <SelectItem value="HIRED">Hired</SelectItem>
                    <SelectItem value="REJECTED">Rejected</SelectItem>
                    <SelectItem value="WITHDRAWN">Withdrawn</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  placeholder="Notes (required for Rejected/Withdrawn)"
                  value={applicationForm.notes}
                  onChange={(e) =>
                    setApplicationForm((prev) => ({ ...prev, notes: e.target.value }))
                  }
                />
              </div>
              <div className="flex justify-end">
                <Button onClick={handleCreateApplication}>Save application</Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </header>

      <Card id="applicants" className="border-border/70">
        <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <CardTitle>Applicants</CardTitle>
            <p className="text-sm text-muted-foreground">
              Intake view for new candidates and fast application creation.
            </p>
            {applicantsFetching ? (
              <p className="text-xs text-muted-foreground">Refreshing applicant results...</p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                downloadServerCsv("/api/admin/hr/hiring/export/applicants", {
                  q: applicantsSearch.trim(),
                  includeHired: showHiredApplicants ? "1" : "0",
                })
              }
            >
              Export applicants CSV
            </Button>
            <label className="flex items-center gap-2 rounded-full border border-border/70 bg-background px-3 py-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={showHiredApplicants}
                onChange={(e) => setShowHiredApplicants(e.target.checked)}
              />
              Show hired
            </label>
            <label className="flex items-center gap-2 rounded-full border border-border/70 bg-background px-3 py-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={compactTables}
                onChange={(e) => setCompactTables(e.target.checked)}
              />
              Compact tables
            </label>
            <Input
              placeholder="Search applicants"
              value={applicantsSearch}
              onChange={(e) => setApplicantsSearch(e.target.value)}
              className="w-full sm:w-72"
            />
          </div>
        </CardHeader>
        <CardContent className={tableDensityClass}>
          {applicantsLoading ? (
            <>
              <SectionCardsSkeleton />
              <SectionTableSkeleton />
            </>
          ) : visibleApplicants.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 px-6 py-10 text-center">
              <p className="text-sm font-medium">No applicants match the current intake filters.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Try a different search term or add a candidate manually.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-3 lg:hidden">
                {visibleApplicants.map((applicant) => (
                  <div key={applicant.id} className="rounded-2xl border border-border/70 bg-background/85 p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium">
                          {applicant.firstName} {applicant.lastName}
                        </div>
                        <div className="mt-1 text-sm text-muted-foreground">
                          {applicant.email || "Email not provided"}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {applicant.phone || "Phone not provided"}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setApplicationForm((prev) => ({
                              ...prev,
                              applicantId: applicant.id,
                            }));
                            setApplicationDialogOpen(true);
                          }}
                        >
                          Create application
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button type="button" size="icon" variant="outline" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleOpenApplicantEdit(applicant)}>
                              Edit applicant
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="hidden lg:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Phone</TableHead>
                      <TableHead className="text-right">Primary action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleApplicants.map((applicant) => (
                      <TableRow key={applicant.id}>
                        <TableCell className="font-medium">
                          {applicant.firstName} {applicant.lastName}
                        </TableCell>
                        <TableCell>{applicant.email || "Not provided"}</TableCell>
                        <TableCell>{applicant.phone || "Not provided"}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setApplicationForm((prev) => ({
                                  ...prev,
                                  applicantId: applicant.id,
                                }));
                                setApplicationDialogOpen(true);
                              }}
                            >
                              Create application
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button type="button" size="icon" variant="outline" className="h-8 w-8">
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => handleOpenApplicantEdit(applicant)}>
                                  Edit applicant
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card id="jobs" className="border-border/70">
        <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <CardTitle>Job Postings</CardTitle>
            <p className="text-sm text-muted-foreground">
              Track role readiness and keep job status changes explicit and auditable.
            </p>
            {jobsFetching ? <p className="text-xs text-muted-foreground">Refreshing job postings...</p> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                downloadServerCsv("/api/admin/hr/hiring/export/jobs", {
                  q: search.trim(),
                  status: status,
                })
              }
            >
              Export jobs CSV
            </Button>
            <Input
              placeholder="Search jobs"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full sm:w-72"
            />
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-full sm:w-[170px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="OPEN">Open</SelectItem>
                <SelectItem value="PAUSED">Paused</SelectItem>
                <SelectItem value="CLOSED">Closed</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className={tableDensityClass}>
          {jobsLoading ? (
            <>
              <SectionCardsSkeleton />
              <SectionTableSkeleton />
            </>
          ) : jobs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 px-6 py-10 text-center">
              <p className="text-sm font-medium">No job postings match the current role filters.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Clear the search or create a new role from the hiring actions bar.
              </p>
            </div>
          ) : (
            <>
              <div className="grid gap-3 lg:hidden">
                {jobs.map((job) => {
                  const salaryLabel =
                    typeof job.salaryMin === "number" || typeof job.salaryMax === "number"
                      ? `${job.salaryMin ? job.salaryMin.toLocaleString() : "0"} - ${job.salaryMax ? job.salaryMax.toLocaleString() : "0"}`
                      : "Salary not set";

                  return (
                    <div key={job.id} className="rounded-2xl border border-border/70 bg-background/85 p-4 shadow-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="font-medium">{job.title}</div>
                          <div className="text-sm text-muted-foreground">
                            {[job.department || "No department", job.location || "Location not set"].join(" | ")}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Opened {formatDateLabel(job.openedAt)}
                            {job.status === "CLOSED" && job.closedAt ? ` | Closed ${formatDateLabel(job.closedAt)}` : ""}
                          </div>
                        </div>
                        <Badge variant={statusTone[job.status]}>{job.status.toLowerCase()}</Badge>
                      </div>
                      <div className="mt-3 rounded-2xl border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                        <div>{salaryLabel}</div>
                        <div className="mt-1 line-clamp-2">{job.description || "No role description added yet."}</div>
                      </div>
                      <div className="mt-4 flex items-center gap-2">
                        <Button type="button" size="sm" variant="outline" onClick={() => handleOpenJobEdit(job)}>
                          Edit role
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button type="button" size="icon" variant="outline" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              disabled={job.status === "OPEN"}
                              onClick={() => handleJobStatusUpdate(job, "OPEN")}
                            >
                              Mark open
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={job.status === "PAUSED"}
                              onClick={() => handleJobStatusUpdate(job, "PAUSED")}
                            >
                              Mark paused
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={job.status === "CLOSED"}
                              onClick={() => setJobCloseDialog({ open: true, jobId: job.id, reason: "" })}
                            >
                              Close role
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="hidden lg:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Role</TableHead>
                      <TableHead>Department</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Hiring window</TableHead>
                      <TableHead className="text-right">Primary action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobs.map((job) => (
                      <TableRow key={job.id}>
                        <TableCell>
                          <div className="font-medium">{job.title}</div>
                          <div className="text-xs text-muted-foreground">
                            {job.location || "Location not set"}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground line-clamp-2">
                            {job.description || "No role description added yet."}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div>{job.department || "-"}</div>
                          <div className="text-xs text-muted-foreground">
                            {typeof job.salaryMin === "number" || typeof job.salaryMax === "number"
                              ? `${job.salaryMin ? job.salaryMin.toLocaleString() : "0"} - ${job.salaryMax ? job.salaryMax.toLocaleString() : "0"}`
                              : "Salary not set"}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusTone[job.status]}>{job.status.toLowerCase()}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">Opened {formatDateLabel(job.openedAt)}</div>
                          <div className="text-xs text-muted-foreground">
                            {job.status === "CLOSED" && job.closedAt ? `Closed ${formatDateLabel(job.closedAt)}` : "Still active"}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button type="button" size="sm" variant="outline" onClick={() => handleOpenJobEdit(job)}>
                              Edit role
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button type="button" size="icon" variant="outline" className="h-8 w-8">
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  disabled={job.status === "OPEN"}
                                  onClick={() => handleJobStatusUpdate(job, "OPEN")}
                                >
                                  Mark open
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={job.status === "PAUSED"}
                                  onClick={() => handleJobStatusUpdate(job, "PAUSED")}
                                >
                                  Mark paused
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={job.status === "CLOSED"}
                                  onClick={() => setJobCloseDialog({ open: true, jobId: job.id, reason: "" })}
                                >
                                  Close role
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card id={applicationSectionId} ref={applicationsSectionRef} className="border-border/70">
        <CardHeader className="space-y-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1">
              <CardTitle>Applications</CardTitle>
              <p className="text-sm text-muted-foreground">
                Server-filtered pipeline view with shareable URL state and mobile-friendly review cards.
              </p>
              {applicationsFetching ? (
                <p className="text-xs text-muted-foreground">Refreshing application pipeline...</p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                placeholder="Search applicant, role, email, phone"
                value={applicationsSearch}
                onChange={(e) => setApplicationsSearch(e.target.value)}
                className="w-full sm:w-72"
              />
              <Select
                value={applicationsStageFilter}
                onValueChange={(value) => applyApplicationView({ stage: value, scroll: true })}
              >
                <SelectTrigger className="w-full sm:w-[160px]">
                  <SelectValue placeholder="Stage" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All stages</SelectItem>
                  {applicationStageOptions.map((stage) => (
                    <SelectItem key={stage.value} value={stage.value}>
                      {stage.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={applicationsJobFilter}
                onValueChange={(value) => applyApplicationView({ job: value, scroll: true })}
              >
                <SelectTrigger className="w-full sm:w-[200px]">
                  <SelectValue placeholder="Role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All roles</SelectItem>
                  {applicationJobs.map(([id, title]) => (
                    <SelectItem key={id} value={id}>
                      {title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={selectedSavedFilterId} onValueChange={handleApplySavedApplicationsFilter}>
                <SelectTrigger className="w-full sm:w-[220px]">
                  <SelectValue placeholder="Saved filter preset" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Saved filters</SelectItem>
                  {savedApplicationFilters.map((filter) => (
                    <SelectItem key={filter.id} value={filter.id}>
                      {filter.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder="Preset name"
                value={savedFilterName}
                onChange={(e) => setSavedFilterName(e.target.value)}
                className="w-full sm:w-40"
              />
              <Button
                ref={savePresetButtonRef}
                type="button"
                variant="outline"
                onClick={handleSaveApplicationsFilter}
              >
                Save preset
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleDeleteSavedApplicationsFilter}
                disabled={selectedSavedFilterId === "none"}
              >
                Delete preset
              </Button>
              <Button type="button" variant="outline" onClick={handleCopyCurrentApplicationView}>
                Copy view link
              </Button>
              <label className="flex items-center gap-2 rounded-full border border-border/70 bg-background px-3 py-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={showHiredApplications}
                  onChange={(e) => applyApplicationView({ showHired: e.target.checked, scroll: true })}
                />
                Show hired applications
              </label>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  downloadServerCsv("/api/admin/hr/hiring/export/applications", {
                    q: applicationsSearch.trim(),
                    stage: applicationsStageFilter,
                    job: applicationsJobFilter,
                    showHired: showHiredApplications ? "1" : "0",
                  })
                }
              >
                Export applications CSV
              </Button>
              <span className="text-xs text-muted-foreground">
                {applicationsFetching ? "Updating view..." : `Last updated: ${applicationsLastUpdatedText}`}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={applicationsStageFilter === "all" && !showHiredApplications ? "default" : "outline"}
              size="sm"
              onClick={() =>
                applyApplicationView({
                  stage: "all",
                  search: "",
                  job: "all",
                  showHired: false,
                  scroll: true,
                })
              }
            >
              All active
            </Button>
            <Button
              type="button"
              variant={applicationsStageFilter === "APPLIED" ? "default" : "outline"}
              size="sm"
              onClick={() =>
                applyApplicationView({
                  stage: "APPLIED",
                  search: "",
                  job: "all",
                  showHired: false,
                  scroll: true,
                })
              }
            >
              Applied
            </Button>
            <Button
              type="button"
              variant={applicationsStageFilter === "INTERVIEW" ? "default" : "outline"}
              size="sm"
              onClick={() =>
                applyApplicationView({
                  stage: "INTERVIEW",
                  search: "",
                  job: "all",
                  showHired: false,
                  scroll: true,
                })
              }
            >
              Interviews
            </Button>
            <Button
              type="button"
              variant={applicationsStageFilter === "OFFER" ? "default" : "outline"}
              size="sm"
              onClick={() =>
                applyApplicationView({
                  stage: "OFFER",
                  search: "",
                  job: "all",
                  showHired: true,
                  scroll: true,
                })
              }
            >
              Offers
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={resetApplicationFilters}
              disabled={!hasActiveApplicationFilters}
            >
              Reset filters
            </Button>
            <span className="self-center text-xs text-muted-foreground">{matchingApplicationsLabel}</span>
          </div>
          <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
            {applicationsViewHint}
          </div>
        </CardHeader>
        <CardContent className={tableDensityClass}>
          {applicationsLoading ? (
            <>
              <SectionCardsSkeleton />
              <SectionTableSkeleton />
            </>
          ) : (
            <>
          <div className="mb-3 grid gap-2 rounded-2xl border border-border/70 bg-background/85 px-4 py-4 text-sm sm:grid-cols-[1fr_1fr_1fr_auto]">
            <Select value={bulkStage} onValueChange={setBulkStage}>
              <SelectTrigger>
                <SelectValue placeholder="Bulk stage" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="APPLIED">Applied</SelectItem>
                <SelectItem value="SCREENING">Screening</SelectItem>
                <SelectItem value="INTERVIEW">Interview</SelectItem>
                <SelectItem value="OFFER">Offer</SelectItem>
                <SelectItem value="HIRED">Hired</SelectItem>
                <SelectItem value="REJECTED">Rejected</SelectItem>
                <SelectItem value="WITHDRAWN">Withdrawn</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="Bulk note (required for rejected/withdrawn)"
              value={bulkNote}
              onChange={(e) => setBulkNote(e.target.value)}
            />
            <div className="text-xs text-muted-foreground self-center">
              Selected: {selectedApplicationIds.length}
            </div>
            <Button
              ref={applyBulkButtonRef}
              type="button"
              onClick={handleBulkStageApply}
              disabled={bulkApplying}
            >
              {bulkApplying ? "Applying..." : "Apply to selected"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleUndoLastBulkUpdate}
              disabled={
                bulkApplying ||
                !lastBulkUndo ||
                lastBulkUndo.items.length === 0 ||
                undoRemainingSeconds <= 0
              }
            >
              {lastBulkUndo && undoRemainingSeconds > 0
                ? `Undo last bulk update (${undoRemainingSeconds}s)`
                : "Undo last bulk update"}
            </Button>
          </div>
          {bulkStage === "HIRED" || bulkStage === "REJECTED" || bulkStage === "WITHDRAWN" ? (
            <div className="mb-3 rounded-2xl border border-border/70 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
              This bulk action requires confirmation and writes the affected application IDs plus any skipped reasons to the audit log.
            </div>
          ) : null}
          {bulkSkippedDetails.length > 0 ? (
            <div className="mb-3 rounded-2xl border border-amber-300/70 bg-amber-50/80 px-4 py-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <div className="font-medium">Skipped applications</div>
              {bulkSkippedDetails.slice(0, 8).map((item) => (
                <div key={`${item.id}-${item.reason}`}>
                  {(applicationNameById.get(item.id) || item.id)}: {item.reason}
                </div>
              ))}
              {bulkSkippedDetails.length > 8 ? (
                <div>and {bulkSkippedDetails.length - 8} more...</div>
              ) : null}
            </div>
          ) : null}
          {visibleApplications.length === 0 ? (
            <div className="mb-3 rounded-2xl border border-dashed border-border/70 bg-muted/20 px-6 py-10 text-center">
              <p className="text-sm font-medium">No applications match the current hiring filters.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Adjust the search or filters, or create a new application from the applicant list.
              </p>
              {hasActiveApplicationFilters ? (
                <div className="mt-4">
                  <Button type="button" variant="outline" onClick={resetApplicationFilters}>
                    Reset application filters
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {visibleApplications.length > 0 ? (
            <div className="space-y-3 lg:hidden">
              {visibleApplications.map((application) => (
                <div key={application.id} className="rounded-2xl border border-border/70 bg-background/85 p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={selectedApplicationIds.includes(application.id)}
                        onChange={(e) => toggleApplicationSelection(application.id, e.target.checked)}
                        className="mt-1"
                      />
                      <div>
                        <div className="font-medium">
                          {application.applicant.firstName} {application.applicant.lastName}
                        </div>
                        <div className="text-sm text-muted-foreground">{application.jobPosting.title}</div>
                      </div>
                    </div>
                    <Badge variant={getStageBadgeVariant(application.stage)}>
                      {formatStageLabel(application.stage)}
                    </Badge>
                  </div>
                  <div className="mt-3 grid gap-2 text-sm text-muted-foreground">
                    <div>Applied {formatDateLabel(application.createdAt)}</div>
                    <div>
                      {(() => {
                        const parsed = parseInterviewFromNotes(application.notes);
                        return parsed.meta?.scheduledAt
                          ? `Interview scheduled ${formatDateLabel(String(parsed.meta.scheduledAt), true)}`
                          : "Interview not scheduled";
                      })()}
                    </div>
                    {application.stage === "HIRED" && application.onboarding ? (
                      <div>
                        <Badge variant={getOnboardingBadgeVariant(application.onboarding.status)}>
                          {application.onboarding.status === "pending" ? "Onboarding pending" : "Onboarding complete"}
                        </Badge>
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-4 flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => handleOpenApplicationDetail(application.id)}
                    >
                      Review
                    </Button>
                    {application.stage === "HIRED" && application.employeeId ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => openOnboardingForEmployee({ employeeId: application.employeeId, applicationId: application.id })}
                      >
                        Resume onboarding
                      </Button>
                    ) : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" size="icon" variant="outline" className="h-8 w-8">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openInterviewPlanner(application)}>
                          Plan interview
                        </DropdownMenuItem>
                        {application.stage === "HIRED" && application.employeeId ? (
                          <DropdownMenuItem onClick={() => openOnboardingForEmployee({ employeeId: application.employeeId, applicationId: application.id })}>
                            Resume onboarding
                          </DropdownMenuItem>
                        ) : null}
                        {getApplicationActionOptions(application).map((stage) => (
                          <DropdownMenuItem
                            key={stage.value}
                            onClick={() => handleApplicationAction(application, stage.value)}
                          >
                            {stage.value === "REJECTED"
                              ? "Reject application"
                              : stage.value === "WITHDRAWN"
                                ? "Withdraw application"
                                : `Move to ${stage.label}`}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          <div className="hidden lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      checked={
                        visibleApplications.length > 0 &&
                        visibleApplications.every((row) => selectedApplicationIds.includes(row.id))
                      }
                      onChange={(e) => toggleSelectAllVisible(e.target.checked)}
                    />
                  </TableHead>
                  <TableHead>Applicant</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Interview</TableHead>
                  <TableHead>Applied</TableHead>
                  <TableHead className="text-right">Primary action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleApplications.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                      No applications yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  visibleApplications.map((application) => (
                    <TableRow key={application.id}>
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={selectedApplicationIds.includes(application.id)}
                          onChange={(e) => toggleApplicationSelection(application.id, e.target.checked)}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">
                          {application.applicant.firstName} {application.applicant.lastName}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {application.applicant.email || application.applicant.phone || "No direct contact on file"}
                        </div>
                      </TableCell>
                      <TableCell>{application.jobPosting.title}</TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <Badge variant={getStageBadgeVariant(application.stage)}>
                            {formatStageLabel(application.stage)}
                          </Badge>
                          {application.stage === "HIRED" && application.onboarding ? (
                            <div>
                              <Badge variant={getOnboardingBadgeVariant(application.onboarding.status)}>
                                {application.onboarding.status === "pending" ? "Onboarding pending" : "Onboarding complete"}
                              </Badge>
                            </div>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-xs text-muted-foreground">
                          {(() => {
                            const parsed = parseInterviewFromNotes(application.notes);
                            return parsed.meta?.scheduledAt
                              ? `Scheduled ${formatDateLabel(String(parsed.meta.scheduledAt), true)}`
                              : "Not scheduled";
                          })()}
                        </div>
                      </TableCell>
                      <TableCell>{formatDateLabel(application.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          {application.stage === "HIRED" && application.employeeId ? (
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => openOnboardingForEmployee({ employeeId: application.employeeId, applicationId: application.id })}
                            >
                              Resume onboarding
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => handleOpenApplicationDetail(application.id)}
                          >
                            Review
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button type="button" size="icon" variant="outline" className="h-8 w-8">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => openInterviewPlanner(application)}>
                                Plan interview
                              </DropdownMenuItem>
                              {application.stage === "HIRED" && application.employeeId ? (
                                <DropdownMenuItem onClick={() => openOnboardingForEmployee({ employeeId: application.employeeId, applicationId: application.id })}>
                                  Resume onboarding
                                </DropdownMenuItem>
                              ) : null}
                              {getApplicationActionOptions(application).map((stage) => (
                                <DropdownMenuItem
                                  key={stage.value}
                                  onClick={() => handleApplicationAction(application, stage.value)}
                                >
                                  {stage.value === "REJECTED"
                                    ? "Reject application"
                                    : stage.value === "WITHDRAWN"
                                      ? "Withdraw application"
                                      : `Move to ${stage.label}`}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
            </>
          )}
        </CardContent>
      </Card>
      <Card id="audit" className="border-border/70">
        <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <CardTitle>Audit and safeguards</CardTitle>
            <p className="text-sm text-muted-foreground">
              Hiring actions are logged in plain English with source page, section, operation, and result summaries.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link href="/admin/audit?sourcePage=admin/hr/hiring">Open hiring audit log</Link>
            </Button>
            {selectedApplicationDetail ? (
              <Button asChild variant="outline">
                <Link
                  href={`/admin/audit?sourcePage=admin/hr/hiring&entityType=APPLICATION&entityId=${encodeURIComponent(selectedApplicationDetail.id)}`}
                >
                  Open selected application audit
                </Link>
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-3">
          <div className="rounded-2xl border border-border/70 bg-background/85 p-4 shadow-sm">
            <div className="text-sm font-medium">Tracked actions</div>
            <div className="mt-2 text-sm text-muted-foreground">
              Applicant edits, role updates, interview plans, application decisions, and exports all retain page context.
            </div>
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/85 p-4 shadow-sm">
            <div className="text-sm font-medium">Bulk safeguards</div>
            <div className="mt-2 text-sm text-muted-foreground">
              Bulk hire, reject, and withdraw actions now require confirmation and log the exact application IDs plus skip reasons.
            </div>
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/85 p-4 shadow-sm">
            <div className="text-sm font-medium">Shareable views</div>
            <div className="mt-2 text-sm text-muted-foreground">
              Filter presets stay local for personal shortcuts, while copied view links preserve the exact application state for review handoffs.
            </div>
          </div>
        </CardContent>
      </Card>
      <Dialog
        open={jobEditDialogOpen}
        onOpenChange={(open) => {
          setJobEditDialogOpen(open);
          if (!open) {
            setEditingJob(null);
            setJobForm(emptyJobForm);
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit job posting</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              placeholder="Job title"
              value={jobForm.title}
              onChange={(e) => setJobForm((prev) => ({ ...prev, title: e.target.value }))}
            />
            <Input
              placeholder="Department"
              value={jobForm.department}
              onChange={(e) => setJobForm((prev) => ({ ...prev, department: e.target.value }))}
            />
            <Select
              value={jobForm.status}
              onValueChange={(value) => setJobForm((prev) => ({ ...prev, status: value }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="OPEN">Open</SelectItem>
                <SelectItem value="PAUSED">Paused</SelectItem>
                <SelectItem value="CLOSED">Closed</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="Location"
              value={jobForm.location}
              onChange={(e) => setJobForm((prev) => ({ ...prev, location: e.target.value }))}
            />
            <Input
              type="datetime-local"
              value={jobForm.openedAt}
              onChange={(e) => setJobForm((prev) => ({ ...prev, openedAt: e.target.value }))}
            />
            <Input
              placeholder="Salary minimum"
              inputMode="numeric"
              value={jobForm.salaryMin}
              onChange={(e) => setJobForm((prev) => ({ ...prev, salaryMin: e.target.value }))}
            />
            <Input
              placeholder="Salary maximum"
              inputMode="numeric"
              value={jobForm.salaryMax}
              onChange={(e) => setJobForm((prev) => ({ ...prev, salaryMax: e.target.value }))}
            />
            <div className="sm:col-span-2">
              <Textarea
                placeholder="Description"
                value={jobForm.description}
                onChange={(e) => setJobForm((prev) => ({ ...prev, description: e.target.value }))}
              />
            </div>
            <div className="sm:col-span-2">
              <Textarea
                placeholder="Requirements"
                value={jobForm.requirements}
                onChange={(e) => setJobForm((prev) => ({ ...prev, requirements: e.target.value }))}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setJobEditDialogOpen(false);
                setEditingJob(null);
                setJobForm(emptyJobForm);
              }}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleSaveJobEdit}>
              Save changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={applicantEditDialogOpen}
        onOpenChange={(open) => {
          setApplicantEditDialogOpen(open);
          if (!open) {
            setEditingApplicant(null);
            setApplicantForm(emptyApplicantForm);
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit applicant</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              placeholder="First name"
              value={applicantForm.firstName}
              onChange={(e) => setApplicantForm((prev) => ({ ...prev, firstName: e.target.value }))}
            />
            <Input
              placeholder="Last name"
              value={applicantForm.lastName}
              onChange={(e) => setApplicantForm((prev) => ({ ...prev, lastName: e.target.value }))}
            />
            <Input
              placeholder="Email"
              value={applicantForm.email}
              onChange={(e) => setApplicantForm((prev) => ({ ...prev, email: e.target.value }))}
            />
            <Input
              placeholder="Phone"
              value={applicantForm.phone}
              onChange={(e) => setApplicantForm((prev) => ({ ...prev, phone: e.target.value }))}
            />
            <Input
              placeholder="Source"
              value={applicantForm.source}
              onChange={(e) => setApplicantForm((prev) => ({ ...prev, source: e.target.value }))}
            />
            <Input
              placeholder="Resume URL"
              value={applicantForm.resumeUrl}
              onChange={(e) => setApplicantForm((prev) => ({ ...prev, resumeUrl: e.target.value }))}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setApplicantEditDialogOpen(false);
                setEditingApplicant(null);
                setApplicantForm(emptyApplicantForm);
              }}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleSaveApplicantEdit}>
              Save changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={applicationDetailDialog.open}
        onOpenChange={(open) =>
          setApplicationDetailDialog({
            open,
            applicationId: open ? applicationDetailDialog.applicationId : "",
          })
        }
      >
        <DialogContent className="max-w-4xl overflow-hidden p-0 sm:ml-auto sm:h-[calc(100vh-4rem)] sm:max-w-3xl">
          {selectedApplicationDetail ? (
            <div className="grid h-full gap-0 lg:grid-cols-[1.35fr_0.85fr]">
              <div className="space-y-6 overflow-y-auto p-6">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={getStageBadgeVariant(selectedApplicationDetail.stage)}>
                      {formatStageLabel(selectedApplicationDetail.stage)}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      Applied {formatDateLabel(selectedApplicationDetail.createdAt)}
                    </span>
                  </div>
                  <div>
                    <h2 className="text-2xl font-semibold">
                      {selectedApplicationDetail.applicant.firstName} {selectedApplicationDetail.applicant.lastName}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      {selectedApplicationDetail.jobPosting.title}
                    </p>
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-2xl border border-border/70 bg-background/90 p-4 shadow-sm">
                    <div className="text-sm font-medium">Applicant</div>
                    <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                      <div>{selectedApplicationDetail.applicant.email || "No email on file"}</div>
                      <div>{selectedApplicationDetail.applicant.phone || "No phone on file"}</div>
                      <div>Source: {selectedApplicationDetail.applicant.source || "Not recorded"}</div>
                      <div>
                        Resume:{" "}
                        {selectedApplicationDetail.applicant.resumeUrl ? (
                          <Link
                            href={selectedApplicationDetail.applicant.resumeUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium text-foreground underline-offset-4 hover:underline"
                          >
                            Open resume
                          </Link>
                        ) : (
                          "Not provided"
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="rounded-2xl border border-border/70 bg-background/90 p-4 shadow-sm">
                    <div className="text-sm font-medium">Role context</div>
                    <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                      <div>{selectedApplicationDetail.jobPosting.department || "No department assigned"}</div>
                      <div>{selectedApplicationDetail.jobPosting.location || "Location not set"}</div>
                      <div>
                        Status:{" "}
                        <span className="font-medium text-foreground">
                          {selectedApplicationDetail.jobPosting.status.toLowerCase()}
                        </span>
                      </div>
                      <div>
                        Salary:{" "}
                        {typeof selectedApplicationDetail.jobPosting.salaryMin === "number" ||
                        typeof selectedApplicationDetail.jobPosting.salaryMax === "number"
                          ? `${selectedApplicationDetail.jobPosting.salaryMin ? selectedApplicationDetail.jobPosting.salaryMin.toLocaleString() : "0"} - ${selectedApplicationDetail.jobPosting.salaryMax ? selectedApplicationDetail.jobPosting.salaryMax.toLocaleString() : "0"}`
                          : "Not set"}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="rounded-2xl border border-border/70 bg-background/90 p-4 shadow-sm">
                  <div className="text-sm font-medium">Interview context</div>
                  <div className="mt-3 grid gap-2 text-sm text-muted-foreground sm:grid-cols-3">
                    <div>
                      <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Scheduled</div>
                      <div className="mt-1 text-foreground">
                        {selectedApplicationInterview.meta?.scheduledAt
                          ? formatDateLabel(String(selectedApplicationInterview.meta.scheduledAt), true)
                          : "Not scheduled"}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Interviewer</div>
                      <div className="mt-1 text-foreground">
                        {selectedApplicationInterview.meta?.interviewer || "Not assigned"}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Outcome</div>
                      <div className="mt-1 text-foreground">
                        {selectedApplicationInterview.meta?.outcome || "Not recorded"}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="rounded-2xl border border-border/70 bg-background/90 p-4 shadow-sm">
                  <div className="text-sm font-medium">Notes</div>
                  <div className="mt-3 rounded-xl border border-border/60 bg-muted/20 p-3 text-sm text-muted-foreground">
                    {selectedApplicationInterview.plain || "No notes recorded yet."}
                  </div>
                </div>
              </div>
              <div className="border-t border-border/70 bg-muted/20 p-6 lg:border-l lg:border-t-0">
                <div className="space-y-4">
                  <div>
                    <div className="text-sm font-medium">Review actions</div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Move the candidate forward, plan interviews, or jump directly into the audit log.
                    </p>
                  </div>
                  <div className="grid gap-2">
                    <Button type="button" variant="outline" onClick={() => openInterviewPlanner(selectedApplicationDetail)}>
                      Plan interview
                    </Button>
                    {selectedApplicationDetail.stage === "HIRED" && selectedApplicationDetail.employeeId ? (
                      <Button
                        type="button"
                        onClick={() =>
                          openOnboardingForEmployee({
                            employeeId: selectedApplicationDetail.employeeId,
                            applicationId: selectedApplicationDetail.id,
                          })
                        }
                      >
                        Resume onboarding
                      </Button>
                    ) : null}
                    <Button asChild variant="outline">
                      <Link
                        href={`/admin/audit?sourcePage=admin/hr/hiring&entityType=APPLICATION&entityId=${encodeURIComponent(selectedApplicationDetail.id)}`}
                      >
                        Open related audit
                      </Link>
                    </Button>
                  </div>
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Stage updates</div>
                    <div className="grid gap-2">
                      {getApplicationActionOptions(selectedApplicationDetail).map((stage) => (
                        <Button
                          key={stage.value}
                          type="button"
                          variant="outline"
                          onClick={() => handleApplicationAction(selectedApplicationDetail, stage.value)}
                        >
                          {stage.value === "REJECTED"
                            ? "Reject application"
                            : stage.value === "WITHDRAWN"
                              ? "Withdraw application"
                              : `Move to ${stage.label}`}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-border/70 bg-background/85 p-4 text-sm text-muted-foreground shadow-sm">
                    <div>Last saved {formatDateLabel(selectedApplicationDetail.updatedAt || selectedApplicationDetail.createdAt, true)}.</div>
                    {selectedApplicationDetail.stage === "HIRED" && selectedApplicationDetail.onboarding ? (
                      <div className="mt-2">{selectedApplicationDetail.onboarding.summary}</div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-6 text-sm text-muted-foreground">Application details are no longer available.</div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={bulkConfirmDialogOpen} onOpenChange={setBulkConfirmDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm bulk stage update</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              You are about to move {selectedApplicationIds.length} application
              {selectedApplicationIds.length === 1 ? "" : "s"} to {formatStageLabel(bulkStage as Application["stage"])}.
            </p>
            <p>This action will be audit-logged with the affected record IDs and any skipped reasons.</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setBulkConfirmDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                setBulkConfirmDialogOpen(false);
                void runBulkStageApply();
              }}
            >
              Confirm bulk update
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={jobCloseDialog.open}
        onOpenChange={(open) =>
          setJobCloseDialog((prev) => ({
            ...prev,
            open,
            ...(open ? {} : { jobId: "", reason: "" }),
          }))
        }
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Close job posting</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              Add a short reason for closing this job posting.
            </p>
            <Input
              placeholder="Reason"
              value={jobCloseDialog.reason}
              onChange={(e) =>
                setJobCloseDialog((prev) => ({ ...prev, reason: e.target.value }))
              }
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setJobCloseDialog({ open: false, jobId: "", reason: "" })}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => {
                  const reason = jobCloseDialog.reason.trim();
                  if (reason.length < 3) {
                    toast.error("Add a short reason (minimum 3 characters).");
                    return;
                  }
                  const job = jobs.find((row) => row.id === jobCloseDialog.jobId);
                  if (!job) {
                    toast.error("Job posting not found.");
                    return;
                  }
                  void handleJobStatusUpdate(job, "CLOSED", reason);
                  setJobCloseDialog({ open: false, jobId: "", reason: "" });
                }}
              >
                Confirm close
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={interviewDialog.open}
        onOpenChange={(open) =>
          setInterviewDialog((prev) => ({
            ...prev,
            open,
            ...(open
              ? {}
              : {
                  applicationId: "",
                  scheduledAt: "",
                  interviewer: "",
                  outcome: "",
                  note: "",
                }),
          }))
        }
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Interview plan</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <Input
              type="datetime-local"
              value={interviewDialog.scheduledAt}
              onChange={(e) =>
                setInterviewDialog((prev) => ({ ...prev, scheduledAt: e.target.value }))
              }
            />
            <Input
              placeholder="Interviewer"
              value={interviewDialog.interviewer}
              onChange={(e) =>
                setInterviewDialog((prev) => ({ ...prev, interviewer: e.target.value }))
              }
            />
            <Input
              placeholder="Outcome (optional)"
              value={interviewDialog.outcome}
              onChange={(e) =>
                setInterviewDialog((prev) => ({ ...prev, outcome: e.target.value }))
              }
            />
            <Input
              placeholder="Interview notes"
              value={interviewDialog.note}
              onChange={(e) => setInterviewDialog((prev) => ({ ...prev, note: e.target.value }))}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setInterviewDialog({
                    open: false,
                    applicationId: "",
                    scheduledAt: "",
                    interviewer: "",
                    outcome: "",
                    note: "",
                  })
                }
              >
                Cancel
              </Button>
              <Button type="button" onClick={handleSaveInterviewPlan}>
                Save interview plan
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={decisionDialog.open}
        onOpenChange={(open) =>
          setDecisionDialog((prev) => ({
            ...prev,
            open,
            ...(open ? {} : { applicationId: "", stage: "", note: "" }),
          }))
        }
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {decisionDialog.stage === "REJECTED" ? "Reject application" : "Withdraw application"}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              Add a short note for audit (minimum 3 characters).
            </p>
            <Input
              placeholder="Decision note"
              value={decisionDialog.note}
              onChange={(e) => setDecisionDialog((prev) => ({ ...prev, note: e.target.value }))}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setDecisionDialog({
                    open: false,
                    applicationId: "",
                    stage: "",
                    note: "",
                  })
                }
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => {
                  if (!decisionDialog.applicationId || !decisionDialog.stage) return;
                  const note = decisionDialog.note.trim();
                  if (note.length < 3) {
                    toast.error("A short note is required.");
                    return;
                  }
                  const selected = applications.find((row) => row.id === decisionDialog.applicationId);
                  if (!selected) {
                    toast.error("Application not found.");
                    return;
                  }
                  void handleApplicationStageUpdate(
                    decisionDialog.applicationId,
                    decisionDialog.stage,
                    selected.updatedAt || "",
                    note,
                  );
                  setDecisionDialog({
                    open: false,
                    applicationId: "",
                    stage: "",
                    note: "",
                  });
                }}
              >
                Confirm
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
