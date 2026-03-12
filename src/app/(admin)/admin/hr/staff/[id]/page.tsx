"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/currency";

type Compensation = {
  id: string;
  baseSalary: number | string;
  allowances: number | string;
  deductions: number | string;
  bonus?: number | string;
  currency: string;
  effectiveDate: string;
  note?: string | null;
};

type Issue = {
  id: string;
  type: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";
  createdAt: string;
  closedAt?: string | null;
};

type Payslip = {
  id: string;
  grossPay: number | string;
  netPay: number | string;
  createdAt: string;
  payrollRun?: { id: string; periodEnd?: string };
};

type OnboardingTask = {
  id: string;
  title: string;
  status: "PENDING" | "COMPLETE";
  dueDate?: string | null;
  completedAt?: string | null;
};

type EmployeeDocument = {
  id: string;
  title: string;
  fileUrl: string;
  fileType?: string | null;
  uploadedAt?: string;
};

type PerformanceReview = {
  id: string;
  rating: "EXCEEDS" | "MEETS" | "NEEDS_IMPROVEMENT" | "UNSATISFACTORY";
  periodStart: string;
  periodEnd: string;
  summary?: string | null;
  strengths?: string | null;
  improvements?: string | null;
  goals?: string | null;
};

type LeaveRequest = {
  id: string;
  type: "ANNUAL" | "SICK" | "UNPAID" | "OTHER";
  status: "REQUESTED" | "APPROVED" | "REJECTED" | "CANCELLED";
  startDate: string;
  endDate: string;
  cancelledAt?: string | null;
};

type EmployeeProfile = {
  id: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  department?: string | null;
  position?: string | null;
  status: "ACTIVE" | "ON_LEAVE" | "SUSPENDED" | "TERMINATED";
  hireDate?: string | null;
  terminationDate?: string | null;
  bankName?: string | null;
  bankAccountName?: string | null;
  bankAccountNumber?: string | null;
  bankCode?: string | null;
  bankBranch?: string | null;
  compensations: Compensation[];
  issues?: Issue[];
  onboardingTasks?: OnboardingTask[];
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function StaffProfilePage() {
  const params = useParams();
  const queryClient = useQueryClient();
  const employeeId = useMemo(() => String(params?.id ?? ""), [params]);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [taskForm, setTaskForm] = useState({ title: "", dueDate: "" });
  const [contactForm, setContactForm] = useState({ email: "", phone: "" });
  const [bankForm, setBankForm] = useState({
    bankName: "",
    bankAccountName: "",
    bankAccountNumber: "",
    bankCode: "",
    bankBranch: "",
  });
  const [bankErrors, setBankErrors] = useState<Record<string, string>>({});
  const [docForm, setDocForm] = useState({ title: "", file: null as File | null });
  const [uploadingDoc, setUploadingDoc] = useState(false);

  const { data: employee } = useQuery({
    queryKey: ["admin", "hr", "employee", employeeId],
    queryFn: () => fetcher(`/api/admin/hr/employees/${employeeId}`),
    enabled: Boolean(employeeId),
  });

  const { data: payslipsData } = useQuery({
    queryKey: ["admin", "hr", "employee", employeeId, "payslips"],
    queryFn: () => fetcher(`/api/admin/hr/payslips?employeeId=${employeeId}`),
    enabled: Boolean(employeeId),
  });

  const { data: documentsData } = useQuery({
    queryKey: ["admin", "hr", "documents", employeeId],
    queryFn: () => fetcher(`/api/admin/hr/documents?employeeId=${employeeId}`),
    enabled: Boolean(employeeId),
  });

  const { data: reviewsData } = useQuery({
    queryKey: ["admin", "hr", "reviews", employeeId],
    queryFn: () => fetcher(`/api/admin/hr/reviews?employeeId=${employeeId}`),
    enabled: Boolean(employeeId),
  });

  const { data: leaveData } = useQuery({
    queryKey: ["admin", "hr", "leave", employeeId],
    queryFn: () => fetcher(`/api/admin/hr/leave?employeeId=${employeeId}`),
    enabled: Boolean(employeeId),
  });

  const { data: settingsData } = useQuery({
    queryKey: ["admin", "hr", "settings", "workweekDays"],
    queryFn: () => fetcher("/api/admin/hr/settings?keys=hr.workweekDays"),
  });

  const profile = employee as EmployeeProfile | undefined;
  const payslips = Array.isArray(payslipsData?.rows)
    ? ([...payslipsData.rows] as Payslip[]).sort((a, b) => {
        const aPeriod = a.payrollRun?.periodEnd
          ? new Date(a.payrollRun.periodEnd).getTime()
          : 0;
        const bPeriod = b.payrollRun?.periodEnd
          ? new Date(b.payrollRun.periodEnd).getTime()
          : 0;
        if (aPeriod !== bPeriod) return bPeriod - aPeriod;
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (aTime !== bTime) return bTime - aTime;
        return a.id.localeCompare(b.id);
      })
    : [];
  const issues = profile?.issues ?? [];
  const onboardingTasks = profile?.onboardingTasks ?? [];
  const documents = Array.isArray(documentsData?.rows)
    ? (documentsData.rows as EmployeeDocument[])
    : [];
  const reviews = Array.isArray(reviewsData?.rows)
    ? (reviewsData.rows as PerformanceReview[])
    : [];
  const leaveRequests = useMemo(
    () => (Array.isArray(leaveData?.rows) ? (leaveData.rows as LeaveRequest[]) : []),
    [leaveData],
  );
  const workweekDays = useMemo(() => {
    const raw = settingsData?.values?.["hr.workweekDays"];
    const num = Number(raw);
    if (Number.isFinite(num) && num >= 5 && num <= 7) return Math.floor(num);
    return 5;
  }, [settingsData]);

  useEffect(() => {
    if (!profile) return;
    setContactForm({
      email: profile.email || "",
      phone: profile.phone || "",
    });
    setBankForm({
      bankName: profile.bankName || "",
      bankAccountName: profile.bankAccountName || "",
      bankAccountNumber: profile.bankAccountNumber || "",
      bankCode: profile.bankCode || "",
      bankBranch: profile.bankBranch || "",
    });
  }, [profile]);

  const leaveSummary = useMemo(() => {
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const yearEnd = new Date(new Date().getFullYear(), 11, 31, 23, 59, 59, 999);
    const approvedTotals: Record<string, number> = {
      ANNUAL: 0,
      SICK: 0,
      UNPAID: 0,
      OTHER: 0,
    };
    const usedTotals: Record<string, number> = {
      ANNUAL: 0,
      SICK: 0,
      UNPAID: 0,
      OTHER: 0,
    };
    let pending = 0;

    const countWorkingDays = (start: Date, end: Date) => {
      const days: number[] = [];
      if (workweekDays >= 7) {
        days.push(0, 1, 2, 3, 4, 5, 6);
      } else if (workweekDays === 6) {
        days.push(1, 2, 3, 4, 5, 6);
      } else {
        days.push(1, 2, 3, 4, 5);
      }
      const s = new Date(start);
      const e = new Date(end);
      s.setHours(0, 0, 0, 0);
      e.setHours(0, 0, 0, 0);
      if (e < s) return 0;
      let count = 0;
      const current = new Date(s);
      while (current <= e) {
        if (days.includes(current.getDay())) count += 1;
        current.setDate(current.getDate() + 1);
      }
      return count;
    };

    const computeUsedDays = (leave: LeaveRequest) => {
      if (leave.status !== "APPROVED" && leave.status !== "CANCELLED") return 0;
      const start = new Date(leave.startDate);
      const end = new Date(leave.endDate);
      const today = new Date();
      const endLimit =
        leave.status === "CANCELLED" && leave.cancelledAt
          ? new Date(leave.cancelledAt)
          : today;
      const cappedEnd = endLimit < end ? endLimit : end;
      if (cappedEnd < start) return 0;
      const approved = countWorkingDays(start, end);
      const used = countWorkingDays(start, cappedEnd);
      return Math.min(approved, used);
    };

    leaveRequests.forEach((leave) => {
      if (leave.status === "REQUESTED") pending += 1;
      if (leave.status !== "APPROVED" && leave.status !== "CANCELLED") return;
      const start = new Date(leave.startDate);
      const end = new Date(leave.endDate);
      if (end < yearStart || start > yearEnd) return;
      const overlapStart = start < yearStart ? yearStart : start;
      const overlapEnd = end > yearEnd ? yearEnd : end;
      const days = countWorkingDays(overlapStart, overlapEnd);
      approvedTotals[leave.type] = (approvedTotals[leave.type] || 0) + days;
      usedTotals[leave.type] = (usedTotals[leave.type] || 0) + computeUsedDays(leave);
    });

    return { approvedTotals, usedTotals, pending };
  }, [leaveRequests, workweekDays]);

  const handleToggleTask = async (taskId: string, status: "PENDING" | "COMPLETE") => {
    try {
      const res = await fetch(`/api/admin/hr/onboarding/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) return;
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "employee", employeeId] });
    } catch {
      // ignore
    }
  };

  const handleCreateTask = async () => {
    if (!taskForm.title.trim()) return;
    try {
      const res = await fetch("/api/admin/hr/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId,
          title: taskForm.title,
          dueDate: taskForm.dueDate ? new Date(taskForm.dueDate).toISOString() : "",
        }),
      });
      if (!res.ok) return;
      setTaskForm({ title: "", dueDate: "" });
      setTaskDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "employee", employeeId] });
    } catch {
      // ignore
    }
  };

  const handleSaveContact = async () => {
    const email = contactForm.email.trim();
    const phone = contactForm.phone.trim();
    if (email && !email.includes("@")) {
      toast.error("Enter a valid email address.");
      return;
    }
    if (phone && phone.length < 5) {
      toast.error("Enter a valid phone number.");
      return;
    }
    try {
      const res = await fetch(`/api/admin/hr/employees/${employeeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, phone }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to update contact details.");
        return;
      }
      toast.success("Contact details updated.");
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "employee", employeeId] });
    } catch {
      toast.error("Failed to update contact details.");
    }
  };

  const handleSaveBank = async () => {
    const errors: Record<string, string> = {};
    if (!bankForm.bankName.trim()) errors.bankName = "Bank name is required.";
    if (!bankForm.bankAccountName.trim()) errors.bankAccountName = "Account name is required.";
    if (!bankForm.bankAccountNumber.trim()) errors.bankAccountNumber = "Account number is required.";
    setBankErrors(errors);
    if (Object.keys(errors).length > 0) {
      toast.error("Fill the required bank details.");
      return;
    }
    try {
      const res = await fetch(`/api/admin/hr/employees/${employeeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bankForm),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to update bank details.");
        return;
      }
      toast.success("Bank details updated.");
      setBankErrors({});
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "employee", employeeId] });
    } catch {
      toast.error("Failed to update bank details.");
    }
  };

  const handleUploadDocument = async () => {
    if (!docForm.file || !docForm.title.trim()) {
      toast.error("Add a title and select a file.");
      return;
    }
    setUploadingDoc(true);
    try {
      const formData = new FormData();
      formData.append("file", docForm.file);
      const uploadRes = await fetch("/api/admin/hr/documents/upload", {
        method: "POST",
        body: formData,
      });
      const uploadBody = await uploadRes.json().catch(() => ({}));
      if (!uploadRes.ok) {
        toast.error(uploadBody.error || "Document upload failed.");
        return;
      }
      if (!uploadBody?.key) {
        toast.error("Upload response missing document reference.");
        return;
      }

      const createRes = await fetch("/api/admin/hr/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId,
          title: docForm.title,
          fileUrl: uploadBody.key,
          fileType: docForm.file.type,
        }),
      });
      const createBody = await createRes.json().catch(() => ({}));
      if (!createRes.ok) {
        toast.error(createBody.error || "Failed to save document.");
        return;
      }
      toast.success("Document uploaded.");
      setDocForm({ title: "", file: null });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "documents", employeeId] });
    } catch {
      toast.error("Document upload failed.");
    } finally {
      setUploadingDoc(false);
    }
  };

  const handleDeleteDocument = async (docId: string) => {
    try {
      const res = await fetch(`/api/admin/hr/documents/${docId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to delete document.");
        return;
      }
      toast.success("Document deleted.");
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "documents", employeeId] });
    } catch {
      toast.error("Failed to delete document.");
    }
  };

  if (!profile) {
    return (
      <section className="space-y-6">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold">Staff Profile</h1>
            <p className="text-muted-foreground">Employee details and history.</p>
          </div>
          <Button asChild variant="outline">
            <Link href="/admin/hr/staff">Back to staff</Link>
          </Button>
        </header>
        <p className="text-sm text-muted-foreground">Loading employee profile...</p>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">
            {profile.firstName} {profile.lastName}
          </h1>
          <p className="text-muted-foreground">Employee profile and HR history.</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/admin/hr/compensation">Compensation</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/hr/staff">Back to staff</Link>
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm sm:grid-cols-2">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Status</div>
            <div className="font-medium">{profile.status}</div>
            <div className="text-xs text-muted-foreground">Department</div>
            <div className="font-medium">{profile.department || "—"}</div>
            <div className="text-xs text-muted-foreground">Position</div>
            <div className="font-medium">{profile.position || "—"}</div>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Contact</div>
            <div className="font-medium">{profile.email || "—"}</div>
            <div className="text-xs text-muted-foreground">Phone</div>
            <div className="font-medium">{profile.phone || "—"}</div>
            <div className="text-xs text-muted-foreground">Hire date</div>
            <div className="font-medium">
              {profile.hireDate ? new Date(profile.hireDate).toLocaleDateString() : "—"}
            </div>
            <div className="text-xs text-muted-foreground">Termination date</div>
            <div className="font-medium">
              {profile.terminationDate ? new Date(profile.terminationDate).toLocaleDateString() : "—"}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Contact Details</CardTitle>
          <Button size="sm" variant="outline" onClick={handleSaveContact}>
            Save contact
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <Input
            placeholder="Email address"
            value={contactForm.email}
            onChange={(e) => setContactForm((prev) => ({ ...prev, email: e.target.value }))}
          />
          <Input
            placeholder="Phone number"
            value={contactForm.phone}
            onChange={(e) => setContactForm((prev) => ({ ...prev, phone: e.target.value }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Payroll Details</CardTitle>
          <Button size="sm" variant="outline" onClick={handleSaveBank}>
            Save bank details
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="grid gap-1">
            <Input
              placeholder="Bank name"
              value={bankForm.bankName}
              onChange={(e) => {
                const value = e.target.value;
                setBankForm((prev) => ({ ...prev, bankName: value }));
                if (bankErrors.bankName && value.trim()) {
                  setBankErrors((prev) => {
                    const next = { ...prev };
                    delete next.bankName;
                    return next;
                  });
                }
              }}
            />
            {bankErrors.bankName ? (
              <p className="text-xs text-red-600">{bankErrors.bankName}</p>
            ) : null}
          </div>
          <div className="grid gap-1">
            <Input
              placeholder="Bank code"
              value={bankForm.bankCode}
              onChange={(e) => setBankForm((prev) => ({ ...prev, bankCode: e.target.value }))}
            />
          </div>
          <div className="grid gap-1">
            <Input
              placeholder="Account name"
              value={bankForm.bankAccountName}
              onChange={(e) => {
                const value = e.target.value;
                setBankForm((prev) => ({ ...prev, bankAccountName: value }));
                if (bankErrors.bankAccountName && value.trim()) {
                  setBankErrors((prev) => {
                    const next = { ...prev };
                    delete next.bankAccountName;
                    return next;
                  });
                }
              }}
            />
            {bankErrors.bankAccountName ? (
              <p className="text-xs text-red-600">{bankErrors.bankAccountName}</p>
            ) : null}
          </div>
          <div className="grid gap-1">
            <Input
              placeholder="Account number"
              value={bankForm.bankAccountNumber}
              onChange={(e) => {
                const value = e.target.value;
                setBankForm((prev) => ({ ...prev, bankAccountNumber: value }));
                if (bankErrors.bankAccountNumber && value.trim()) {
                  setBankErrors((prev) => {
                    const next = { ...prev };
                    delete next.bankAccountNumber;
                    return next;
                  });
                }
              }}
            />
            {bankErrors.bankAccountNumber ? (
              <p className="text-xs text-red-600">{bankErrors.bankAccountNumber}</p>
            ) : null}
          </div>
          <div className="grid gap-1">
            <Input
              placeholder="Branch"
              value={bankForm.bankBranch}
              onChange={(e) => setBankForm((prev) => ({ ...prev, bankBranch: e.target.value }))}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Documents</CardTitle>
          <div className="flex gap-2">
            <Input
              placeholder="Document title"
              value={docForm.title}
              onChange={(e) => setDocForm((prev) => ({ ...prev, title: e.target.value }))}
              className="w-48"
            />
            <Input
              type="file"
              onChange={(e) => setDocForm((prev) => ({ ...prev, file: e.target.files?.[0] ?? null }))}
              className="w-56"
            />
            <Button size="sm" variant="outline" onClick={handleUploadDocument} disabled={uploadingDoc}>
              {uploadingDoc ? "Uploading..." : "Upload"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {documents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No documents uploaded yet.</p>
          ) : (
            <div className="grid gap-2 text-sm">
              {documents.map((doc) => (
                <div key={doc.id} className="flex flex-wrap items-center justify-between gap-3 rounded border px-3 py-2">
                  <div>
                    <div className="font-medium">{doc.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {doc.fileType || "Document"} ·{" "}
                      {doc.uploadedAt ? new Date(doc.uploadedAt).toLocaleDateString() : "—"}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button asChild size="sm" variant="secondary">
                      <a href={`/api/admin/hr/documents/${doc.id}/download`} target="_blank" rel="noreferrer">
                        View
                      </a>
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => handleDeleteDocument(doc.id)}>
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Performance Reviews</CardTitle>
          <Button asChild size="sm" variant="outline">
            <Link href={`/admin/hr/reviews?employeeId=${employeeId}`}>Open reviews</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {reviews.length === 0 ? (
            <p className="text-sm text-muted-foreground">No reviews recorded yet.</p>
          ) : (
            <div className="grid gap-3 text-sm">
              <div className="rounded border px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-medium">
                      {new Date(reviews[0].periodStart).toLocaleDateString()} -{" "}
                      {new Date(reviews[0].periodEnd).toLocaleDateString()}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Latest review · {reviews[0].rating.replace("_", " ")}
                    </div>
                  </div>
                </div>
                <div className="mt-3 grid gap-2 text-xs text-muted-foreground">
                  <div>
                    <span className="font-semibold text-foreground">Summary:</span>{" "}
                    {reviews[0].summary || "—"}
                  </div>
                  <div>
                    <span className="font-semibold text-foreground">Strengths:</span>{" "}
                    {reviews[0].strengths || "—"}
                  </div>
                  <div>
                    <span className="font-semibold text-foreground">Improvements:</span>{" "}
                    {reviews[0].improvements || "—"}
                  </div>
                  <div>
                    <span className="font-semibold text-foreground">Goals:</span>{" "}
                    {reviews[0].goals || "—"}
                  </div>
                </div>
              </div>
              {reviews.slice(1, 5).map((review) => (
                <div key={review.id} className="flex flex-wrap items-center justify-between gap-3 rounded border px-3 py-2">
                  <div>
                    <div className="font-medium">
                      {new Date(review.periodStart).toLocaleDateString()} -{" "}
                      {new Date(review.periodEnd).toLocaleDateString()}
                    </div>
                    <div className="text-xs text-muted-foreground">{review.summary || "No summary"}</div>
                  </div>
                  <div className="text-xs font-semibold">{review.rating.replace("_", " ")}</div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Leave Summary (YTD)</CardTitle>
          <Button asChild size="sm" variant="outline">
            <Link href={`/admin/hr/leave?employeeId=${employeeId}`}>View leave</Link>
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded border px-3 py-2">
            <div className="text-xs text-muted-foreground">Annual leave approved/used</div>
            <div className="font-medium">
              {leaveSummary.approvedTotals.ANNUAL}/{leaveSummary.usedTotals.ANNUAL} days
            </div>
          </div>
          <div className="rounded border px-3 py-2">
            <div className="text-xs text-muted-foreground">Sick leave approved/used</div>
            <div className="font-medium">
              {leaveSummary.approvedTotals.SICK}/{leaveSummary.usedTotals.SICK} days
            </div>
          </div>
          <div className="rounded border px-3 py-2">
            <div className="text-xs text-muted-foreground">Unpaid leave approved/used</div>
            <div className="font-medium">
              {leaveSummary.approvedTotals.UNPAID}/{leaveSummary.usedTotals.UNPAID} days
            </div>
          </div>
          <div className="rounded border px-3 py-2">
            <div className="text-xs text-muted-foreground">Other leave approved/used</div>
            <div className="font-medium">
              {leaveSummary.approvedTotals.OTHER}/{leaveSummary.usedTotals.OTHER} days
            </div>
          </div>
          <div className="rounded border px-3 py-2 sm:col-span-2">
            <div className="text-xs text-muted-foreground">Pending requests</div>
            <div className="font-medium">{leaveSummary.pending}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Onboarding Checklist</CardTitle>
          <Dialog open={taskDialogOpen} onOpenChange={setTaskDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">Add Task</Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Add Onboarding Task</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3">
                <Input
                  placeholder="Task title"
                  value={taskForm.title}
                  onChange={(e) => setTaskForm((prev) => ({ ...prev, title: e.target.value }))}
                />
                <Input
                  type="date"
                  value={taskForm.dueDate}
                  onChange={(e) => setTaskForm((prev) => ({ ...prev, dueDate: e.target.value }))}
                />
              </div>
              <div className="flex justify-end">
                <Button onClick={handleCreateTask}>Save task</Button>
              </div>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          {onboardingTasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No onboarding tasks yet.</p>
          ) : (
            <div className="grid gap-2 text-sm">
              {onboardingTasks.map((task) => (
                <label key={task.id} className="flex items-center justify-between gap-3 rounded border px-3 py-2">
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={task.status === "COMPLETE"}
                      onChange={(e) =>
                        handleToggleTask(task.id, e.target.checked ? "COMPLETE" : "PENDING")
                      }
                    />
                    <div>
                      <div className="font-medium">{task.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {task.dueDate ? `Due ${new Date(task.dueDate).toLocaleDateString()}` : "No due date"}
                      </div>
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {task.status === "COMPLETE" ? "Completed" : "Pending"}
                  </div>
                </label>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Compensation History</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Effective</TableHead>
                <TableHead>Base</TableHead>
                <TableHead>Allowances</TableHead>
                <TableHead>Deductions</TableHead>
                <TableHead>Bonus</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profile.compensations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                    No compensation records yet.
                  </TableCell>
                </TableRow>
              ) : (
                profile.compensations.map((comp) => (
                  <TableRow key={comp.id}>
                    <TableCell>{new Date(comp.effectiveDate).toLocaleDateString()}</TableCell>
                    <TableCell>{formatCurrency(Number(comp.baseSalary || 0))}</TableCell>
                    <TableCell>{formatCurrency(Number(comp.allowances || 0))}</TableCell>
                    <TableCell>{formatCurrency(Number(comp.deductions || 0))}</TableCell>
                    <TableCell>{formatCurrency(Number(comp.bonus || 0))}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{comp.note || "—"}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Payslips</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Gross</TableHead>
                <TableHead>Net</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payslips.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                    No payslips found.
                  </TableCell>
                </TableRow>
              ) : (
                payslips.map((slip) => (
                  <TableRow key={slip.id}>
                    <TableCell className="text-xs text-muted-foreground">
                      {slip.payrollRun?.id ? slip.payrollRun.id.slice(0, 8) : "—"}
                    </TableCell>
                    <TableCell>{formatCurrency(Number(slip.grossPay || 0))}</TableCell>
                    <TableCell>{formatCurrency(Number(slip.netPay || 0))}</TableCell>
                    <TableCell>{new Date(slip.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell className="flex flex-wrap gap-2">
                      <Button asChild size="sm" variant="secondary">
                        <Link href={`/admin/hr/paystubs/${slip.id}`}>View</Link>
                      </Button>
                      {slip.payrollRun?.id ? (
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/admin/hr/payroll/${slip.payrollRun.id}`}>Run</Link>
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Staff Issues</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Logged</TableHead>
                <TableHead>Closed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {issues.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                    No issues recorded.
                  </TableCell>
                </TableRow>
              ) : (
                issues.map((issue) => (
                  <TableRow key={issue.id}>
                    <TableCell>{issue.type}</TableCell>
                    <TableCell>{issue.severity}</TableCell>
                    <TableCell>{issue.status}</TableCell>
                    <TableCell>{new Date(issue.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell>{issue.closedAt ? new Date(issue.closedAt).toLocaleDateString() : "—"}</TableCell>
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
