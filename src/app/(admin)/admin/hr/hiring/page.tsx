"use client";

export const dynamic = "force-dynamic";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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

type JobPosting = {
  id: string;
  title: string;
  department?: string | null;
  status: "OPEN" | "PAUSED" | "CLOSED";
  openedAt: string;
  closedAt?: string | null;
};

type Applicant = {
  id: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
};

type Application = {
  id: string;
  stage: "APPLIED" | "SCREENING" | "INTERVIEW" | "OFFER" | "HIRED" | "REJECTED" | "WITHDRAWN";
  applicant: Applicant;
  jobPosting: JobPosting;
  createdAt: string;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const statusTone: Record<JobPosting["status"], "default" | "secondary"> = {
  OPEN: "default",
  PAUSED: "secondary",
  CLOSED: "secondary",
};

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
  });

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
        body: JSON.stringify({ rows: importRows }),
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

  const jobs = Array.isArray(jobsData?.rows) ? (jobsData.rows as JobPosting[]) : [];
  const applicants = Array.isArray(applicantsData?.rows) ? (applicantsData.rows as Applicant[]) : [];
  const applications = Array.isArray(applicationsData?.rows)
    ? (applicationsData.rows as Application[])
    : [];
  const visibleApplications = showHiredApplications
    ? applications
    : applications.filter((application) => application.stage !== "HIRED");

  const handleCreateJob = async () => {
    try {
      const res = await fetch("/api/admin/hr/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(jobForm),
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
    try {
      const res = await fetch("/api/admin/hr/applicants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(applicantForm),
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
    try {
      const res = await fetch("/api/admin/hr/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(applicationForm),
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
      setApplicationForm({ applicantId: "", jobPostingId: "", stage: "APPLIED" });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "applications"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to create application.");
    }
  };

  const handleJobStatusUpdate = async (jobId: string, nextStatus: JobPosting["status"]) => {
    try {
      const res = await fetch(`/api/admin/hr/jobs/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
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
    nextStage: Application["stage"]
  ) => {
    try {
      const res = await fetch(`/api/admin/hr/applications/${applicationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: nextStage }),
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

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Hiring Pipeline</h1>
          <p className="text-muted-foreground">Manage job postings and applicants.</p>
        </div>
        <div className="flex flex-wrap gap-2">
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
              </div>
              <div className="flex justify-end">
                <Button onClick={handleCreateApplication}>Save application</Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </header>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Job Postings</CardTitle>
          <div className="flex flex-wrap gap-2">
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
        <CardContent>
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
                          onValueChange={(value) =>
                            handleJobStatusUpdate(job.id, value as JobPosting["status"])
                          }
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
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showHiredApplications}
              onChange={(e) => setShowHiredApplications(e.target.checked)}
            />
            Show hired applications
          </label>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Applicant</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Applied</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleApplications.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                    No applications yet.
                  </TableCell>
                </TableRow>
              ) : (
                visibleApplications.map((application) => (
                  <TableRow key={application.id}>
                    <TableCell>
                      {application.applicant.firstName} {application.applicant.lastName}
                    </TableCell>
                    <TableCell>{application.jobPosting.title}</TableCell>
                    <TableCell>
                      <Select
                        value={application.stage}
                        onValueChange={(value) =>
                          handleApplicationStageUpdate(
                            application.id,
                            value as Application["stage"]
                          )
                        }
                      >
                        <SelectTrigger className="h-7 w-full sm:w-[160px] text-xs">
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
                    </TableCell>
                    <TableCell>{new Date(application.createdAt).toLocaleDateString()}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </section>
  );
}
