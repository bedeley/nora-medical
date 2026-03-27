"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
  status: "OPEN" | "PAUSED" | "CLOSED";
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
  updatedAt?: string;
};

type Application = {
  id: string;
  stage: "APPLIED" | "SCREENING" | "INTERVIEW" | "OFFER" | "HIRED" | "REJECTED" | "WITHDRAWN";
  notes?: string | null;
  applicant: Applicant;
  jobPosting: JobPosting;
  createdAt: string;
  updatedAt?: string;
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

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const statusTone: Record<JobPosting["status"], "default" | "secondary"> = {
  OPEN: "default",
  PAUSED: "secondary",
  CLOSED: "secondary",
};
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

export default function AdminHrHiringPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [jobDialogOpen, setJobDialogOpen] = useState(false);
  const [applicantDialogOpen, setApplicantDialogOpen] = useState(false);
  const [applicationDialogOpen, setApplicationDialogOpen] = useState(false);
  const [showHiredApplicants, setShowHiredApplicants] = useState(false);
  const [showHiredApplications, setShowHiredApplications] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importRows, setImportRows] = useState<Record<string, string>[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [selectedApplicationIds, setSelectedApplicationIds] = useState<string[]>([]);
  const [bulkStage, setBulkStage] = useState("SCREENING");
  const [bulkNote, setBulkNote] = useState("");
  const [bulkApplying, setBulkApplying] = useState(false);
  const [compactTables, setCompactTables] = useState(false);
  const [applicantsSearch, setApplicantsSearch] = useState("");
  const [applicationsSearch, setApplicationsSearch] = useState("");
  const [applicationsStageFilter, setApplicationsStageFilter] = useState("all");
  const [applicationsJobFilter, setApplicationsJobFilter] = useState("all");
  const [savedApplicationFilters, setSavedApplicationFilters] = useState<SavedApplicationFilter[]>([]);
  const [selectedSavedFilterId, setSelectedSavedFilterId] = useState("none");
  const [savedFilterName, setSavedFilterName] = useState("");
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
    status: "OPEN",
    description: "",
  });
  const [applicantForm, setApplicantForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
  });
  const [applicationForm, setApplicationForm] = useState({
    applicantId: "",
    jobPostingId: "",
    stage: "APPLIED",
    notes: "",
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

  const { data: jobsData } = useQuery({
    queryKey: ["admin", "hr", "jobs", search, status],
    queryFn: () => fetcher(jobsQuery),
  });
  const { data: applicantsData } = useQuery({
    queryKey: ["admin", "hr", "applicants", showHiredApplicants],
    queryFn: () =>
      fetcher(`/api/admin/hr/applicants?includeHired=${showHiredApplicants ? "1" : "0"}`),
  });
  const { data: applicationsData } = useQuery({
    queryKey: ["admin", "hr", "applications"],
    queryFn: () => fetcher("/api/admin/hr/applications"),
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
  const hiringKpis = useMemo(() => {
    const openJobs = jobs.filter((row) => row.status === "OPEN").length;
    const pipelineActive = applications.filter(
      (row) => !["HIRED", "REJECTED", "WITHDRAWN"].includes(row.stage),
    ).length;
    const interviews = applications.filter((row) => row.stage === "INTERVIEW").length;
    const offers = applications.filter((row) => row.stage === "OFFER").length;
    return { openJobs, pipelineActive, interviews, offers };
  }, [applications, jobs]);
  const visibleApplicants = useMemo(() => {
    const query = applicantsSearch.trim().toLowerCase();
    return applicants.filter((row) => {
      if (!query) return true;
      const name = `${row.firstName} ${row.lastName}`.toLowerCase();
      const email = String(row.email || "").toLowerCase();
      const phone = String(row.phone || "").toLowerCase();
      return name.includes(query) || email.includes(query) || phone.includes(query);
    });
  }, [applicants, applicantsSearch]);
  const applicationJobs = useMemo(
    () =>
      Array.from(
        new Map(applications.map((row) => [row.jobPosting.id, row.jobPosting.title])).entries(),
      ),
    [applications],
  );
  const visibleApplications = useMemo(() => {
    const query = applicationsSearch.trim().toLowerCase();
    return applications.filter((application) => {
      if (!showHiredApplications && application.stage === "HIRED") return false;
      if (applicationsStageFilter !== "all" && application.stage !== applicationsStageFilter) return false;
      if (applicationsJobFilter !== "all" && application.jobPosting.id !== applicationsJobFilter) return false;
      if (!query) return true;
      const applicantName = `${application.applicant.firstName} ${application.applicant.lastName}`.toLowerCase();
      const applicantEmail = String(application.applicant.email || "").toLowerCase();
      const applicantPhone = String(application.applicant.phone || "").toLowerCase();
      const role = application.jobPosting.title.toLowerCase();
      return (
        applicantName.includes(query) ||
        applicantEmail.includes(query) ||
        applicantPhone.includes(query) ||
        role.includes(query)
      );
    });
  }, [
    applications,
    applicationsJobFilter,
    applicationsSearch,
    applicationsStageFilter,
    showHiredApplications,
  ]);
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
  const applicationsLastUpdatedText = useMemo(() => {
    if (applications.length === 0) return "Not available";
    const latest = applications
      .map((row) => {
        const raw = row.updatedAt || row.createdAt;
        const date = new Date(raw);
        return Number.isNaN(date.getTime()) ? 0 : date.getTime();
      })
      .reduce((max, value) => (value > max ? value : max), 0);
    if (!latest) return "Not available";
    return new Date(latest).toLocaleString();
  }, [applications]);
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
    toast.success("Filter preset saved.");
  };

  const handleApplySavedApplicationsFilter = (id: string) => {
    setSelectedSavedFilterId(id);
    if (id === "none") return;
    const selected = savedApplicationFilters.find((row) => row.id === id);
    if (!selected) {
      toast.error("Saved filter not found.");
      return;
    }
    setApplicationsSearch(selected.search);
    setApplicationsStageFilter(selected.stage);
    setApplicationsJobFilter(selected.job);
    setShowHiredApplications(selected.showHired);
    toast.success("Saved filter applied.");
  };

  const handleDeleteSavedApplicationsFilter = () => {
    if (selectedSavedFilterId === "none") return;
    setSavedApplicationFilters((prev) => prev.filter((row) => row.id !== selectedSavedFilterId));
    setSelectedSavedFilterId("none");
    toast.success("Saved filter deleted.");
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

  const toggleSelectAllVisible = (checked: boolean) => {
    if (checked) {
      setSelectedApplicationIds(visibleApplications.map((row) => row.id));
      return;
    }
    setSelectedApplicationIds([]);
  };

  const handleCreateJob = async () => {
    if (!jobForm.title.trim()) {
      toast.error("Job title is required.");
      return;
    }
    try {
      const res = await fetch("/api/admin/hr/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...jobForm,
          sourcePage,
          section: "job-postings",
          operation: "create_job_posting",
          resultSummary: "Job posting created from hiring page.",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to create job posting.");
        return;
      }
      toast.success("Job posting created.");
      setJobDialogOpen(false);
      setJobForm({ title: "", department: "", status: "OPEN", description: "" });
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
          resultSummary: "Applicant added from hiring page.",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to add applicant.");
        return;
      }
      toast.success("Applicant added.");
      setApplicantDialogOpen(false);
      setApplicantForm({ firstName: "", lastName: "", email: "", phone: "" });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "applicants"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to add applicant.");
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
          resultSummary: "Application created from hiring page.",
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
      setApplicationDialogOpen(false);
      setApplicationForm({ applicantId: "", jobPostingId: "", stage: "APPLIED", notes: "" });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "applications"] });
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
              ? `Job posting status updated. Reason: ${closeReason.trim()}`
              : "Job posting status updated from hiring page.",
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
              ? `Application stage changed with note: ${decisionNote.trim()}`
              : "Application stage updated from hiring page.",
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
    } catch (err) {
      console.error(err);
      toast.error("Failed to update stage.");
    }
  };

  const handleBulkStageApply = async () => {
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
    const applicationsSnapshot = queryClient.getQueryData<{ rows?: Application[] }>([
      "admin",
      "hr",
      "applications",
    ]);
    const snapshotRows = Array.isArray(applicationsSnapshot?.rows) ? applicationsSnapshot.rows : [];
    const expectedUpdatedAtById = Object.fromEntries(
      snapshotRows
        .filter((row) => selectedApplicationIds.includes(row.id))
        .map((row) => [row.id, String(row.updatedAt || "")]),
    );
    const selectedIds = [...selectedApplicationIds];
    const targetStage = bulkStage as Application["stage"];
    queryClient.setQueryData<{ rows?: Application[] }>(["admin", "hr", "applications"], (prev) => {
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
          resultSummary: "Bulk application stage update from hiring page.",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        queryClient.setQueryData(["admin", "hr", "applications"], applicationsSnapshot);
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
      queryClient.setQueryData<{ rows?: Application[] }>(["admin", "hr", "applications"], (prev) => {
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
      queryClient.setQueryData(["admin", "hr", "applications"], applicationsSnapshot);
      toast.error("Bulk update failed.");
    } finally {
      setBulkApplying(false);
    }
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
            resultSummary: "Previous bulk stage update was undone from hiring page.",
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
          resultSummary: "Interview plan updated from hiring page.",
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

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Hiring Pipeline</h1>
          <p className="text-muted-foreground">Manage job postings and applicants.</p>
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
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                    {importErrors.slice(0, 5).map((err) => (
                      <div key={err}>{err}</div>
                    ))}
                    {importErrors.length > 5 ? <div>…</div> : null}
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
              <div className="grid gap-3">
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
                  placeholder="Description"
                  value={jobForm.description}
                  onChange={(e) => setJobForm((prev) => ({ ...prev, description: e.target.value }))}
                />
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

      <Card>
        <CardHeader>
          <CardTitle>Hiring Snapshot</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded border px-3 py-2">
            <div className="text-xs text-muted-foreground">Open jobs</div>
            <div className="font-medium">{hiringKpis.openJobs}</div>
          </div>
          <div className="rounded border px-3 py-2">
            <div className="text-xs text-muted-foreground">Active pipeline</div>
            <div className="font-medium">{hiringKpis.pipelineActive}</div>
          </div>
          <div className="rounded border px-3 py-2">
            <div className="text-xs text-muted-foreground">Interview stage</div>
            <div className="font-medium">{hiringKpis.interviews}</div>
          </div>
          <div className="rounded border px-3 py-2">
            <div className="text-xs text-muted-foreground">Offer stage</div>
            <div className="font-medium">{hiringKpis.offers}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Applicants</CardTitle>
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
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
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
              className="w-full sm:w-64"
            />
          </div>
        </CardHeader>
        <CardContent className={tableDensityClass}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleApplicants.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                    No applicants found.
                  </TableCell>
                </TableRow>
              ) : (
                visibleApplicants.map((applicant) => (
                  <TableRow key={applicant.id}>
                    <TableCell>{applicant.firstName} {applicant.lastName}</TableCell>
                    <TableCell>{applicant.email || "Not provided"}</TableCell>
                    <TableCell>{applicant.phone || "Not provided"}</TableCell>
                    <TableCell>
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
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Job Postings</CardTitle>
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
              className="w-full sm:w-64"
            />
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-full sm:w-[160px]">
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">
                    No job postings found.
                  </TableCell>
                </TableRow>
              ) : (
                jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>
                      <div className="font-medium">{job.title}</div>
                      <div className="text-xs text-muted-foreground">
                        Opened {new Date(job.openedAt).toLocaleDateString()}
                      </div>
                      {job.status === "CLOSED" && job.closedAt ? (
                        <div className="text-xs text-muted-foreground">
                          Closed {new Date(job.closedAt).toLocaleDateString()}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>{job.department || "—"}</TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Badge variant={statusTone[job.status]}>{job.status.toLowerCase()}</Badge>
                        <Select
                          value={job.status}
                          onValueChange={(value) => {
                            const nextStatus = value as JobPosting["status"];
                            if (nextStatus === "CLOSED" && job.status !== "CLOSED") {
                              setJobCloseDialog({ open: true, jobId: job.id, reason: "" });
                              return;
                            }
                            handleJobStatusUpdate(job, nextStatus);
                          }}
                        >
                          <SelectTrigger className="h-7 w-full sm:w-[140px] text-xs">
                            <SelectValue placeholder="Update" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="OPEN">Open</SelectItem>
                            <SelectItem value="PAUSED">Paused</SelectItem>
                            <SelectItem value="CLOSED">Closed</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Applications</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search applicant, role, email, phone"
              value={applicationsSearch}
              onChange={(e) => setApplicationsSearch(e.target.value)}
              className="w-full sm:w-72"
            />
            <Select value={applicationsStageFilter} onValueChange={setApplicationsStageFilter}>
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
            <Select value={applicationsJobFilter} onValueChange={setApplicationsJobFilter}>
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
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={showHiredApplications}
                onChange={(e) => setShowHiredApplications(e.target.checked)}
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
              Last updated: {applicationsLastUpdatedText}
            </span>
          </div>
        </CardHeader>
        <CardContent className={tableDensityClass}>
          <div className="mb-3 grid gap-2 rounded border px-3 py-3 text-sm sm:grid-cols-[1fr_1fr_1fr_auto]">
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
          {bulkSkippedDetails.length > 0 ? (
            <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleApplications.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
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
                        onChange={(e) =>
                          toggleApplicationSelection(application.id, e.target.checked)
                        }
                      />
                    </TableCell>
                    <TableCell>
                      {application.applicant.firstName} {application.applicant.lastName}
                    </TableCell>
                    <TableCell>{application.jobPosting.title}</TableCell>
                    <TableCell>
                      <Select
                        value={application.stage}
                        onValueChange={(value) => {
                          const nextStage = value as Application["stage"];
                          if (nextStage === "REJECTED" || nextStage === "WITHDRAWN") {
                            setDecisionDialog({
                              open: true,
                              applicationId: application.id,
                              stage: nextStage,
                              note: "",
                            });
                            return;
                          }
                          handleApplicationStageUpdate(
                            application.id,
                            nextStage,
                            application.updatedAt || "",
                          );
                        }}
                      >
                        <SelectTrigger className="h-7 w-full sm:w-[160px] text-xs">
                          <SelectValue placeholder="Stage" />
                        </SelectTrigger>
                        <SelectContent>
                          {applicationStageOptions.map((stage) => {
                            const isCurrent = stage.value === application.stage;
                            const transition = validateApplicationStageTransition(
                              application.stage,
                              stage.value,
                            );
                            const isAllowed = isCurrent || transition.ok;
                            return (
                              <SelectItem key={stage.value} value={stage.value} disabled={!isAllowed}>
                                {stage.label}
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">
                          {(() => {
                            const parsed = parseInterviewFromNotes(application.notes);
                            return parsed.meta?.scheduledAt
                              ? `Scheduled ${new Date(String(parsed.meta.scheduledAt)).toLocaleString()}`
                              : "Not scheduled";
                          })()}
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => openInterviewPlanner(application)}
                        >
                          Plan interview
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell>{new Date(application.createdAt).toLocaleDateString()}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
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
