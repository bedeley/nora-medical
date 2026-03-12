"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronDown } from "lucide-react";
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
import { formatCurrency } from "@/lib/currency";
import Link from "next/link";

type Employee = {
  id: string;
  firstName: string;
  lastName: string;
};

type Compensation = {
  id: string;
  employeeId: string;
  baseSalary: number | string;
  allowances: number | string;
  deductions: number | string;
  bonus?: number | string;
  currency: string;
  effectiveDate: string;
  status?: "DRAFT" | "PENDING" | "ACTIVE";
};

type PayrollRun = {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: "DRAFT" | "FINALIZED" | "PAID" | "CANCELLED";
  runType?: "REGULAR" | "ADJUSTMENT";
  adjustmentForId?: string | null;
  adjustmentNote?: string | null;
  totalGross: number | string;
  totalNet: number | string;
  expense?: { id: string } | null;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function AdminHrCompensationPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [payrollDialogOpen, setPayrollDialogOpen] = useState(false);
  const [monthlyDialogOpen, setMonthlyDialogOpen] = useState(false);
  const [checklistOpen, setChecklistOpen] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingComp, setPendingComp] = useState<Compensation | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [pendingCancelRun, setPendingCancelRun] = useState<PayrollRun | null>(null);
  const checklistStorageKey = "hr-compensation-checklist-open";

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(checklistStorageKey);
    if (stored === "false") setChecklistOpen(false);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(checklistStorageKey, String(checklistOpen));
  }, [checklistOpen]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    baseSalary: "",
    allowances: "",
    deductions: "",
    bonus: "",
    effectiveDate: "",
    currency: "GHS",
  });
  const [form, setForm] = useState({
    employeeId: "",
    baseSalary: "",
    allowances: "",
    deductions: "",
    bonus: "",
    currency: "GHS",
    effectiveDate: "",
  });
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [payrollForm, setPayrollForm] = useState({
    periodStart: "",
    periodEnd: "",
    status: "DRAFT",
    totalGross: "",
    totalNet: "",
  });
  const [monthlyForm, setMonthlyForm] = useState({
    year: new Date().getFullYear().toString(),
    month: (new Date().getMonth() + 1).toString(),
    taxPercent: "",
    pensionPercent: "",
    bonus: "",
  });
  const [showCancelled, setShowCancelled] = useState(false);

  const { data: employeesData } = useQuery({
    queryKey: ["admin", "hr", "employees"],
    queryFn: () => fetcher("/api/admin/hr/employees"),
  });
  const { data: compensationData } = useQuery({
    queryKey: ["admin", "hr", "compensation"],
    queryFn: () => fetcher("/api/admin/hr/compensation"),
  });
  const { data: payrollData } = useQuery({
    queryKey: ["admin", "hr", "payroll"],
    queryFn: () => fetcher("/api/admin/hr/payroll"),
  });
  const { data: cronStatus } = useQuery({
    queryKey: ["admin", "hr", "cron-status"],
    queryFn: () => fetcher("/api/admin/hr/payroll/cron/status"),
  });

  const employees = Array.isArray(employeesData?.rows) ? (employeesData.rows as Employee[]) : [];
  const compensations = Array.isArray(compensationData?.rows) ? (compensationData.rows as Compensation[]) : [];
  const payrollRuns = Array.isArray(payrollData?.rows) ? (payrollData.rows as PayrollRun[]) : [];
  const visibleRuns = payrollRuns.filter((run) => showCancelled || run.status !== "CANCELLED");
  const cronEnabled = Boolean(cronStatus?.enabled);

  const handleCreateCompensation = async () => {
    try {
      const payload = {
        employeeId: form.employeeId,
        baseSalary: Number(form.baseSalary || 0),
        allowances: Number(form.allowances || 0),
        deductions: Number(form.deductions || 0),
        bonus: Number(form.bonus || 0),
        currency: form.currency,
        effectiveDate: form.effectiveDate ? new Date(form.effectiveDate).toISOString() : undefined,
        status: requiresApproval ? "PENDING" : "ACTIVE",
      };
      const res = await fetch("/api/admin/hr/compensation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to add compensation.");
        return;
      }
      toast.success("Compensation saved.");
      setDialogOpen(false);
      setForm({
        employeeId: "",
        baseSalary: "",
        allowances: "",
        deductions: "",
        bonus: "",
        currency: "GHS",
        effectiveDate: "",
      });
      setRequiresApproval(false);
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "compensation"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to add compensation.");
    }
  };

  const handleCreatePayroll = async () => {
    try {
      const payload = {
        periodStart: payrollForm.periodStart
          ? new Date(payrollForm.periodStart).toISOString()
          : "",
        periodEnd: payrollForm.periodEnd ? new Date(payrollForm.periodEnd).toISOString() : "",
        status: payrollForm.status,
        totalGross: Number(payrollForm.totalGross || 0),
        totalNet: Number(payrollForm.totalNet || 0),
      };
      const res = await fetch("/api/admin/hr/payroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to create payroll run.");
        return;
      }
      toast.success("Payroll run created.");
      setPayrollDialogOpen(false);
      setPayrollForm({
        periodStart: "",
        periodEnd: "",
        status: "DRAFT",
        totalGross: "",
        totalNet: "",
      });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to create payroll run.");
    }
  };

  const handleGenerateMonthly = async () => {
    try {
      const payload = {
        year: Number(monthlyForm.year),
        month: Number(monthlyForm.month),
        taxPercent: Number(monthlyForm.taxPercent || 0),
        pensionPercent: Number(monthlyForm.pensionPercent || 0),
        bonus: Number(monthlyForm.bonus || 0),
      };
      const res = await fetch("/api/admin/hr/payroll/generate-monthly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to generate monthly paystubs.");
        return;
      }
      toast.success(`Generated ${body.created ?? 0} payslip(s).`);
      setMonthlyDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to generate monthly paystubs.");
    }
  };

  const startEdit = (comp: Compensation) => {
    setPendingComp(comp);
    setConfirmOpen(true);
  };

  const confirmEdit = () => {
    if (!pendingComp) {
      setConfirmOpen(false);
      return;
    }
    const comp = pendingComp;
    setEditingId(comp.id);
    setEditForm({
      baseSalary: String(comp.baseSalary ?? ""),
      allowances: String(comp.allowances ?? ""),
      deductions: String(comp.deductions ?? ""),
      bonus: String(comp.bonus ?? ""),
      effectiveDate: comp.effectiveDate
        ? new Date(comp.effectiveDate).toISOString().slice(0, 10)
        : "",
      currency: comp.currency || "GHS",
    });
    setConfirmOpen(false);
    setPendingComp(null);
  };

  const handleUpdateCompensation = async () => {
    if (!editingId) return;
    try {
      const payload = {
        baseSalary: Number(editForm.baseSalary || 0),
        allowances: Number(editForm.allowances || 0),
        deductions: Number(editForm.deductions || 0),
        bonus: Number(editForm.bonus || 0),
        currency: editForm.currency,
        effectiveDate: editForm.effectiveDate
          ? new Date(editForm.effectiveDate).toISOString()
          : "",
      };
      const res = await fetch(`/api/admin/hr/compensation/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to update compensation.");
        return;
      }
      toast.success("Compensation updated.");
      setEditingId(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "compensation"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to update compensation.");
    }
  };

  const handleUpdateCompStatus = async (
    compId: string,
    status: "DRAFT" | "PENDING" | "ACTIVE"
  ) => {
    try {
      const res = await fetch(`/api/admin/hr/compensation/${compId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to update status.");
        return;
      }
      toast.success("Compensation status updated.");
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "compensation"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to update status.");
    }
  };

  const handleUpdatePayrollStatus = async (
    runId: string,
    status: "FINALIZED" | "PAID" | "CANCELLED",
    createExpense: boolean
  ) => {
    if (!runId) {
      toast.error("Missing payroll run id.");
      return;
    }
    try {
      const res = await fetch(`/api/admin/hr/payroll/${runId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, createExpense }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to update payroll status.");
        return;
      }
      toast.success("Payroll updated.");
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to update payroll status.");
    }
  };

  const formatPeriod = (run: PayrollRun) =>
    `${new Date(run.periodStart).toLocaleDateString()} - ${new Date(run.periodEnd).toLocaleDateString()}`;

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Compensation & Payroll</h1>
          <p className="text-muted-foreground">Track salary history and payroll runs.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Cron status: {cronEnabled ? "enabled" : "disabled"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button>+ Compensation</Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>Add Compensation</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3">
                <Select
                  value={form.employeeId}
                  onValueChange={(value) => setForm((prev) => ({ ...prev, employeeId: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select employee" />
                  </SelectTrigger>
                  <SelectContent>
                    {employees.map((employee) => (
                      <SelectItem key={employee.id} value={employee.id}>
                        {employee.firstName} {employee.lastName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  placeholder="Base salary"
                  value={form.baseSalary}
                  onChange={(e) => setForm((prev) => ({ ...prev, baseSalary: e.target.value }))}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    type="number"
                    placeholder="Allowances"
                    value={form.allowances}
                    onChange={(e) => setForm((prev) => ({ ...prev, allowances: e.target.value }))}
                  />
                  <Input
                    type="number"
                    placeholder="Deductions"
                    value={form.deductions}
                    onChange={(e) => setForm((prev) => ({ ...prev, deductions: e.target.value }))}
                  />
                  <Input
                    type="number"
                    placeholder="Bonus (optional)"
                    value={form.bonus}
                    onChange={(e) => setForm((prev) => ({ ...prev, bonus: e.target.value }))}
                  />
                </div>
                <Input
                  placeholder="Currency"
                  value={form.currency}
                  onChange={(e) => setForm((prev) => ({ ...prev, currency: e.target.value }))}
                />
                <Input
                  type="date"
                  value={form.effectiveDate}
                  onChange={(e) => setForm((prev) => ({ ...prev, effectiveDate: e.target.value }))}
                />
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={requiresApproval}
                    onChange={(e) => setRequiresApproval(e.target.checked)}
                  />
                  Require approval before activation
                </label>
              </div>
              <div className="flex justify-end">
                <Button onClick={handleCreateCompensation}>Save compensation</Button>
              </div>
            </DialogContent>
          </Dialog>
          <Dialog open={monthlyDialogOpen} onOpenChange={setMonthlyDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="secondary">Generate Monthly Paystubs</Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>Generate Monthly Paystubs</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  type="number"
                  placeholder="Year"
                  value={monthlyForm.year}
                  onChange={(e) =>
                    setMonthlyForm((prev) => ({ ...prev, year: e.target.value }))
                  }
                />
                <Select
                  value={monthlyForm.month}
                  onValueChange={(value) =>
                    setMonthlyForm((prev) => ({ ...prev, month: value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Month" />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 12 }, (_, i) => {
                      const month = (i + 1).toString();
                      return (
                        <SelectItem key={month} value={month}>
                          {month}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  placeholder="Tax %"
                  value={monthlyForm.taxPercent}
                  onChange={(e) =>
                    setMonthlyForm((prev) => ({ ...prev, taxPercent: e.target.value }))
                  }
                />
                <Input
                  type="number"
                  placeholder="Pension %"
                  value={monthlyForm.pensionPercent}
                  onChange={(e) =>
                    setMonthlyForm((prev) => ({ ...prev, pensionPercent: e.target.value }))
                  }
                />
                <Input
                  type="number"
                  placeholder="Bonus (flat)"
                  value={monthlyForm.bonus}
                  onChange={(e) =>
                    setMonthlyForm((prev) => ({ ...prev, bonus: e.target.value }))
                  }
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Bonus here is a default. Per-employee bonus in compensation overrides it.
              </p>
              <p className="text-xs text-muted-foreground">
                Month is required and must be between 1 and 12.
              </p>
              <div className="flex justify-end">
                <Button onClick={handleGenerateMonthly}>Generate</Button>
              </div>
            </DialogContent>
          </Dialog>
          <Button
            variant="ghost"
            onClick={() => setAdvancedOpen((open) => !open)}
            aria-expanded={advancedOpen}
          >
            {advancedOpen ? "Hide advanced" : "Show advanced"}
            <ChevronDown className={`ml-2 h-4 w-4 ${advancedOpen ? "rotate-180" : ""}`} />
          </Button>
        </div>
      </header>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm Correction</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            Use Correct to fix mistakes only. For salary changes, add a new record instead.
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmEdit}>Continue</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel Draft Payroll Run</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            Cancel this draft payroll run for{" "}
            <strong>{pendingCancelRun ? formatPeriod(pendingCancelRun) : "this period"}</strong>?
            This will delete its payslips.
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCancelOpen(false)}>
              Keep Draft
            </Button>
            <Button
              onClick={() => {
                if (!pendingCancelRun) return;
                handleUpdatePayrollStatus(pendingCancelRun.id, "CANCELLED", false);
                setCancelOpen(false);
                setPendingCancelRun(null);
              }}
            >
              Cancel Draft
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {advancedOpen ? (
        <Card>
          <CardHeader>
            <CardTitle>Advanced Payroll Tools</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-muted-foreground">
              Use manual payroll runs for off-cycle payments, corrections, or custom periods.
            </div>
            <Dialog open={payrollDialogOpen} onOpenChange={setPayrollDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline">+ Payroll run</Button>
              </DialogTrigger>
              <DialogContent className="max-w-xl">
                <DialogHeader>
                  <DialogTitle>Create Payroll Run</DialogTitle>
                </DialogHeader>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    type="date"
                    value={payrollForm.periodStart}
                    onChange={(e) =>
                      setPayrollForm((prev) => ({ ...prev, periodStart: e.target.value }))
                    }
                  />
                  <Input
                    type="date"
                    value={payrollForm.periodEnd}
                    onChange={(e) =>
                      setPayrollForm((prev) => ({ ...prev, periodEnd: e.target.value }))
                    }
                  />
                  <Input
                    type="number"
                    placeholder="Total gross"
                    value={payrollForm.totalGross}
                    onChange={(e) =>
                      setPayrollForm((prev) => ({ ...prev, totalGross: e.target.value }))
                    }
                  />
                  <Input
                    type="number"
                    placeholder="Total net"
                    value={payrollForm.totalNet}
                    onChange={(e) =>
                      setPayrollForm((prev) => ({ ...prev, totalNet: e.target.value }))
                    }
                  />
                  <Select
                    value={payrollForm.status}
                    onValueChange={(value) => setPayrollForm((prev) => ({ ...prev, status: value }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="DRAFT">Draft</SelectItem>
                      <SelectItem value="FINALIZED">Finalized</SelectItem>
                      <SelectItem value="PAID">Paid</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex justify-end">
                  <Button onClick={handleCreatePayroll}>Save payroll run</Button>
                </div>
              </DialogContent>
            </Dialog>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>Monthly Payroll Checklist</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setChecklistOpen((open) => !open)}
            aria-expanded={checklistOpen}
          >
            {checklistOpen ? "Hide" : "Show"}
            <ChevronDown
              className={`ml-2 h-4 w-4 transition-transform ${checklistOpen ? "rotate-180" : ""}`}
            />
          </Button>
        </CardHeader>
        {checklistOpen ? (
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <div>1) Add or update compensation records for any staff changes.</div>
            <div>2) Click “Generate Monthly Paystubs” and enter tax/pension/bonus.</div>
            <div>3) Review the payroll run totals and employee breakdown.</div>
            <div>4) Click “Finalize Run” to lock and create the payroll expense.</div>
            <div>5) After payments are sent, click “Mark Run Paid”.</div>
            <div>6) Print paystubs for employees as needed.</div>
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader className="space-y-1">
          <CardTitle>Compensation Records</CardTitle>
          <p className="text-xs text-muted-foreground">
            Use “Correct” to fix mistakes. Add a new record for salary changes.
          </p>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Base</TableHead>
                <TableHead>Allowances</TableHead>
                <TableHead>Deductions</TableHead>
                <TableHead>Bonus</TableHead>
                <TableHead>Effective</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
          <TableBody>
            {compensations.length === 0 ? (
                <TableRow>
                      <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                        No compensation records yet.
                      </TableCell>
                </TableRow>
              ) : (
                compensations.map((comp) => {
                  const employee = employees.find((e) => e.id === comp.employeeId);
                  const isEditing = editingId === comp.id;
                  return (
                    <TableRow key={comp.id}>
                      <TableCell>
                        {employee ? `${employee.firstName} ${employee.lastName}` : "—"}
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <Input
                            type="number"
                            value={editForm.baseSalary}
                            onChange={(e) =>
                              setEditForm((prev) => ({ ...prev, baseSalary: e.target.value }))
                            }
                          />
                        ) : (
                          formatCurrency(Number(comp.baseSalary))
                        )}
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <Input
                            type="number"
                            value={editForm.allowances}
                            onChange={(e) =>
                              setEditForm((prev) => ({ ...prev, allowances: e.target.value }))
                            }
                          />
                        ) : (
                          formatCurrency(Number(comp.allowances || 0))
                        )}
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <Input
                            type="number"
                            value={editForm.deductions}
                            onChange={(e) =>
                              setEditForm((prev) => ({ ...prev, deductions: e.target.value }))
                            }
                          />
                        ) : (
                          formatCurrency(Number(comp.deductions || 0))
                        )}
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <Input
                            type="number"
                            value={editForm.bonus}
                            onChange={(e) =>
                              setEditForm((prev) => ({ ...prev, bonus: e.target.value }))
                            }
                          />
                        ) : (
                          formatCurrency(Number(comp.bonus || 0))
                        )}
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <Input
                            type="date"
                            value={editForm.effectiveDate}
                            onChange={(e) =>
                              setEditForm((prev) => ({ ...prev, effectiveDate: e.target.value }))
                            }
                          />
                        ) : comp.effectiveDate ? (
                          new Date(comp.effectiveDate).toLocaleDateString()
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="text-xs font-medium">
                          {comp.status || "ACTIVE"}
                        </span>
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <div className="flex gap-2">
                            <Button size="sm" onClick={handleUpdateCompensation}>
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setEditingId(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="outline" onClick={() => startEdit(comp)}>
                              Correct
                            </Button>
                            {comp.status === "DRAFT" ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleUpdateCompStatus(comp.id, "PENDING")}
                              >
                                Submit
                              </Button>
                            ) : null}
                            {comp.status === "PENDING" ? (
                              <Button
                                size="sm"
                                onClick={() => handleUpdateCompStatus(comp.id, "ACTIVE")}
                              >
                                Approve
                              </Button>
                            ) : null}
                            <Button asChild size="sm" variant="secondary">
                              <Link href={`/admin/hr/staff/${comp.employeeId}/paystubs`}>
                                Paystubs
                              </Link>
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Payroll Runs</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowCancelled((prev) => !prev)}
          >
            {showCancelled ? "Hide cancelled" : "Show cancelled"}
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Gross</TableHead>
                <TableHead>Net</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRuns.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                    No payroll runs to show.
                  </TableCell>
                </TableRow>
              ) : (
                visibleRuns.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      {new Date(run.periodStart).toLocaleDateString()} -{" "}
                      {new Date(run.periodEnd).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <div className="text-xs font-medium">
                        {run.runType === "ADJUSTMENT" ? "Adjustment" : "Regular"}
                      </div>
                      {run.runType === "ADJUSTMENT" && run.adjustmentForId ? (
                        <Link
                          href={`/admin/hr/payroll/${run.adjustmentForId}`}
                          className="text-xs underline text-muted-foreground"
                        >
                          View original
                        </Link>
                      ) : null}
                    </TableCell>
                    <TableCell>{run.status}</TableCell>
                    <TableCell>{formatCurrency(Number(run.totalGross || 0))}</TableCell>
                    <TableCell>{formatCurrency(Number(run.totalNet || 0))}</TableCell>
                    <TableCell>
                      {run.status === "CANCELLED" ? (
                        <span className="text-xs text-muted-foreground">Cancelled</span>
                      ) : run.status === "DRAFT" ? (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            onClick={() =>
                              handleUpdatePayrollStatus(run.id, "FINALIZED", !run.expense)
                            }
                          >
                            Finalize Run
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setPendingCancelRun(run);
                              setCancelOpen(true);
                            }}
                          >
                            Cancel Draft
                          </Button>
                          <Button asChild size="sm" variant="secondary">
                            <Link href={`/admin/hr/payroll/${run.id}`}>View</Link>
                          </Button>
                        </div>
                      ) : !run.expense ? (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              handleUpdatePayrollStatus(
                                run.id,
                                run.status as "FINALIZED" | "PAID" | "CANCELLED",
                                true
                              )
                            }
                          >
                            Create Expense
                          </Button>
                          <Button asChild size="sm" variant="secondary">
                            <Link href={`/admin/hr/payroll/${run.id}`}>View</Link>
                          </Button>
                        </div>
                      ) : run.status === "FINALIZED" ? (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleUpdatePayrollStatus(run.id, "PAID", false)}
                          >
                            Mark Paid
                          </Button>
                          <Button asChild size="sm" variant="secondary">
                            <Link href={`/admin/hr/payroll/${run.id}`}>View</Link>
                          </Button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          <span className="text-xs text-muted-foreground">Complete</span>
                          <Button asChild size="sm" variant="secondary">
                            <Link href={`/admin/hr/payroll/${run.id}`}>View</Link>
                          </Button>
                        </div>
                      )}
                    </TableCell>
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
