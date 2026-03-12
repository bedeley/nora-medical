"use client";

export const dynamic = "force-dynamic";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
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
import { Textarea } from "@/components/ui/textarea";
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

type Payslip = {
  id: string;
  employeeId: string;
  grossPay: number | string;
  netPay: number | string;
  lineItems?: Record<string, number> | null;
  employee: { firstName: string; lastName: string };
};

type Employee = {
  id: string;
  firstName: string;
  lastName: string;
};

type PayrollRun = {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: "DRAFT" | "FINALIZED" | "PAID" | "CANCELLED";
  runType?: "REGULAR" | "ADJUSTMENT";
  adjustmentForId?: string | null;
  adjustmentFor?: {
    id: string;
    periodStart: string;
    periodEnd: string;
    status: "DRAFT" | "FINALIZED" | "PAID" | "CANCELLED";
  } | null;
  adjustmentsCount?: number;
  adjustmentNote?: string | null;
  totalGross: number | string;
  totalNet: number | string;
  expense?: { id: string } | null;
  payslips: Payslip[];
  ytdTotals?: Record<
    string,
    { gross: number; net: number; deductions: number; tax: number; pension: number }
  >;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function PayrollRunDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const runId = useMemo(() => String(params?.id ?? ""), [params]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [adjustmentOpen, setAdjustmentOpen] = useState(false);
  const [netOverride, setNetOverride] = useState(false);
  const [form, setForm] = useState({
    employeeId: "",
    grossPay: "",
    netPay: "",
    tax: "",
    pension: "",
    bonus: "",
    allowances: "",
    otherEarnings: "",
    otherDeductions: "",
  });
  const [generateForm, setGenerateForm] = useState({
    taxPercent: "",
    pensionPercent: "",
    bonus: "",
  });
  const [adjustmentNote, setAdjustmentNote] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "hr", "payroll", runId],
    queryFn: () => fetcher(`/api/admin/hr/payroll/${runId}`),
    enabled: Boolean(runId),
  });

  const { data: employeesData } = useQuery({
    queryKey: ["admin", "hr", "employees"],
    queryFn: () => fetcher("/api/admin/hr/employees"),
  });

  const employees = Array.isArray(employeesData?.rows) ? (employeesData.rows as Employee[]) : [];
  const run = data as PayrollRun | undefined;

  const updateStatus = async (status: "FINALIZED" | "PAID" | "CANCELLED", createExpense: boolean) => {
    if (!runId) return;
    try {
      const res = await fetch(`/api/admin/hr/payroll/${runId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, createExpense }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to update payroll.");
        return;
      }
      toast.success("Payroll updated.");
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll", runId] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to update payroll.");
    }
  };

  const handleCreatePayslip = async () => {
    if (!form.employeeId) {
      toast.error("Select an employee.");
      return;
    }
    const gross = Number(form.grossPay || 0);
    const lineItems = {
      tax: Number(form.tax || 0),
      pension: Number(form.pension || 0),
      bonus: Number(form.bonus || 0),
      allowances: Number(form.allowances || 0),
      otherEarnings: Number(form.otherEarnings || 0),
      otherDeductions: Number(form.otherDeductions || 0),
    };
    const deductions = Number(lineItems.tax || 0) + Number(lineItems.pension || 0) + Number(lineItems.otherDeductions || 0);
    const additions = Number(lineItems.bonus || 0) + Number(lineItems.allowances || 0) + Number(lineItems.otherEarnings || 0);
    const computedNet = gross + additions - deductions;
    const hasLineItems = Object.values(lineItems).some((value) => value !== 0);
    try {
      const payload = {
        payrollRunId: runId,
        employeeId: form.employeeId,
        grossPay: gross,
        netPay: netOverride ? Number(form.netPay || 0) : computedNet,
        lineItems: hasLineItems ? lineItems : undefined,
      };
      const res = await fetch("/api/admin/hr/payslips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to create payslip.");
        return;
      }
      toast.success("Payslip created.");
      setDialogOpen(false);
      setNetOverride(false);
      setForm({
        employeeId: "",
        grossPay: "",
        netPay: "",
        tax: "",
        pension: "",
        bonus: "",
        allowances: "",
        otherEarnings: "",
        otherDeductions: "",
      });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll", runId] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to create payslip.");
    }
  };

  const handleExportCsv = async () => {
    if (!runId) return;
    try {
      const res = await fetch(`/api/admin/hr/payroll/${runId}/export`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to export payroll.");
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `payroll-${runId}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      toast.error("Failed to export payroll.");
    }
  };

  const handleBankExport = async () => {
    if (!runId) return;
    try {
      const res = await fetch(`/api/admin/hr/payroll/${runId}/bank-export`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err?.missing?.length) {
          toast.error("Missing bank details for some employees.");
        } else {
          toast.error(err.error || "Failed to export bank file.");
        }
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `payroll-bank-${runId}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      toast.error("Failed to export bank file.");
    }
  };

  const handleGeneratePayslips = async () => {
    if (!runId) return;
    try {
      const payload = {
        taxPercent: Number(generateForm.taxPercent || 0),
        pensionPercent: Number(generateForm.pensionPercent || 0),
        bonus: Number(generateForm.bonus || 0),
      };
      const res = await fetch(`/api/admin/hr/payroll/${runId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to generate payslips.");
        return;
      }
      toast.success(`Generated ${body.created ?? 0} payslip(s).`);
      setGenerateOpen(false);
      setGenerateForm({ taxPercent: "", pensionPercent: "", bonus: "" });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll", runId] });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to generate payslips.");
    }
  };

  const getLineItem = (slip: Payslip, key: string) => {
    if (!slip.lineItems || typeof slip.lineItems !== "object") return 0;
    const value = slip.lineItems[key];
    return Number(value || 0);
  };

  const computedNet = () => {
    const gross = Number(form.grossPay || 0);
    const deductions =
      Number(form.tax || 0) +
      Number(form.pension || 0) +
      Number(form.otherDeductions || 0);
    const additions =
      Number(form.bonus || 0) +
      Number(form.allowances || 0) +
      Number(form.otherEarnings || 0);
    return gross + additions - deductions;
  };

  const handleCreateAdjustment = async () => {
    if (!runId) return;
    try {
      const res = await fetch(`/api/admin/hr/payroll/${runId}/adjustment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: adjustmentNote.trim() || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to create adjustment run.");
        return;
      }
      toast.success("Adjustment run created.");
      setAdjustmentOpen(false);
      setAdjustmentNote("");
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll"] });
      router.push(`/admin/hr/payroll/${body.id}`);
    } catch (err) {
      console.error(err);
      toast.error("Failed to create adjustment run.");
    }
  };

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Payroll Run</h1>
          <p className="text-muted-foreground">Review payslips and payroll totals.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={handleExportCsv}>
            Export CSV
          </Button>
          <Button variant="outline" onClick={handleBankExport}>
            Export Bank CSV
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/hr/compensation">Back to payroll</Link>
          </Button>
        </div>
      </header>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading payroll run...</p>
      ) : !run ? (
        <p className="text-sm text-muted-foreground">Payroll run not found.</p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Run Summary</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm sm:grid-cols-2">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Period</div>
                <div className="font-medium">
                  {new Date(run.periodStart).toLocaleDateString()} -{" "}
                  {new Date(run.periodEnd).toLocaleDateString()}
                </div>
                <div className="text-xs text-muted-foreground">Status</div>
                <div className="font-medium">{run.status}</div>
                <div className="text-xs text-muted-foreground">Run Type</div>
                <div className="font-medium">
                  {run.runType === "ADJUSTMENT" ? "Adjustment" : "Regular"}
                </div>
                {run.runType === "ADJUSTMENT" && run.adjustmentFor ? (
                  <div className="text-xs text-muted-foreground">
                    Adjustment for{" "}
                    <Link
                      href={`/admin/hr/payroll/${run.adjustmentFor.id}`}
                      className="underline"
                    >
                      {new Date(run.adjustmentFor.periodStart).toLocaleDateString()} -{" "}
                      {new Date(run.adjustmentFor.periodEnd).toLocaleDateString()}
                    </Link>
                  </div>
                ) : null}
                {run.runType !== "ADJUSTMENT" && (run.adjustmentsCount || 0) > 0 ? (
                  <div className="text-xs text-muted-foreground">
                    {run.adjustmentsCount} adjustment run(s) exist for this period.
                  </div>
                ) : null}
                {run.adjustmentNote ? (
                  <div className="text-xs text-muted-foreground">Note: {run.adjustmentNote}</div>
                ) : null}
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Current Gross</div>
                <div className="font-medium">{formatCurrency(Number(run.totalGross || 0))}</div>
                <div className="text-xs text-muted-foreground">Current Net</div>
                <div className="font-medium">{formatCurrency(Number(run.totalNet || 0))}</div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Run Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="text-muted-foreground">
                Generate payslips automatically or add a manual entry, then finalize the run when
                totals are reviewed.
              </div>
              {run.runType === "ADJUSTMENT" ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  Adjustment runs start at zero. Add manual payslips to record the correction and
                  update gross/net totals.
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {run.runType !== "ADJUSTMENT" ? (
                  <Dialog open={generateOpen} onOpenChange={setGenerateOpen}>
                    <DialogTrigger asChild>
                      <Button variant="outline">Generate Payslips</Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-lg">
                      <DialogHeader>
                        <DialogTitle>Generate Payslips</DialogTitle>
                      </DialogHeader>
                      <div className="grid gap-3">
                        <Input
                          type="number"
                          placeholder="Tax % (e.g., 10)"
                          value={generateForm.taxPercent}
                          onChange={(e) =>
                            setGenerateForm((prev) => ({ ...prev, taxPercent: e.target.value }))
                          }
                        />
                        <Input
                          type="number"
                          placeholder="Pension % (e.g., 5)"
                          value={generateForm.pensionPercent}
                          onChange={(e) =>
                            setGenerateForm((prev) => ({ ...prev, pensionPercent: e.target.value }))
                          }
                        />
                        <Input
                          type="number"
                          placeholder="Bonus (flat amount per employee)"
                          value={generateForm.bonus}
                          onChange={(e) =>
                            setGenerateForm((prev) => ({ ...prev, bonus: e.target.value }))
                          }
                        />
                        <p className="text-xs text-muted-foreground">
                          Active employees only. New hires/terminations are prorated by days worked.
                        </p>
                      </div>
                      <div className="flex justify-end">
                        <Button onClick={handleGeneratePayslips}>Generate</Button>
                      </div>
                    </DialogContent>
                  </Dialog>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    Adjustment runs use manual payslips only.
                  </div>
                )}
                <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                  <DialogTrigger asChild>
                    <Button variant="secondary">Add Manual Payslip</Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-xl">
                    <DialogHeader>
                      <DialogTitle>Add Payslip</DialogTitle>
                    </DialogHeader>
                    <div className="grid gap-3">
                      <Select
                        value={form.employeeId}
                        onValueChange={(value) =>
                          setForm((prev) => ({ ...prev, employeeId: value }))
                        }
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
                        placeholder="Gross pay"
                        value={form.grossPay}
                        onChange={(e) =>
                          setForm((prev) => ({ ...prev, grossPay: e.target.value }))
                        }
                      />
                      <Input
                        type="number"
                        placeholder="Net pay"
                        value={
                          netOverride ? form.netPay : computedNet().toFixed(2)
                        }
                        readOnly={!netOverride}
                        onChange={(e) =>
                          setForm((prev) => ({ ...prev, netPay: e.target.value }))
                        }
                      />
                      <div className="text-[11px] text-muted-foreground">
                        Net = Gross + bonuses/allowances/other earnings − tax/pension/other
                        deductions.
                      </div>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={netOverride}
                          onChange={(e) => setNetOverride(e.target.checked)}
                        />
                        Override net manually
                      </label>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Input
                          type="number"
                          placeholder="Tax"
                          value={form.tax}
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, tax: e.target.value }))
                          }
                        />
                        <Input
                          type="number"
                          placeholder="Pension"
                          value={form.pension}
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, pension: e.target.value }))
                          }
                        />
                        <Input
                          type="number"
                          placeholder="Bonus"
                          value={form.bonus}
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, bonus: e.target.value }))
                          }
                        />
                        <Input
                          type="number"
                          placeholder="Allowances"
                          value={form.allowances}
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, allowances: e.target.value }))
                          }
                        />
                        <Input
                          type="number"
                          placeholder="Other earnings"
                          value={form.otherEarnings}
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, otherEarnings: e.target.value }))
                          }
                        />
                        <Input
                          type="number"
                          placeholder="Other deductions"
                          value={form.otherDeductions}
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, otherDeductions: e.target.value }))
                          }
                        />
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <Button onClick={handleCreatePayslip}>Save payslip</Button>
                    </div>
                  </DialogContent>
                </Dialog>
                {run.status === "DRAFT" ? (
                  <Button onClick={() => updateStatus("FINALIZED", !run.expense)}>
                    Finalize Run
                  </Button>
                ) : null}
                {run.status === "DRAFT" ? (
                  <Button variant="outline" onClick={() => updateStatus("CANCELLED", false)}>
                    Cancel Draft
                  </Button>
                ) : null}
                {run.status !== "DRAFT" && !run.expense ? (
                  <Button
                    variant="outline"
                    onClick={() =>
                      updateStatus(run.status as "FINALIZED" | "PAID" | "CANCELLED", true)
                    }
                  >
                    Create Expense Entry
                  </Button>
                ) : null}
                {run.status === "FINALIZED" ? (
                  <Button variant="outline" onClick={() => updateStatus("PAID", false)}>
                    Mark Run Paid
                  </Button>
                ) : null}
                {(run.status === "FINALIZED" || run.status === "PAID") &&
                run.runType !== "ADJUSTMENT" ? (
                  <Dialog open={adjustmentOpen} onOpenChange={setAdjustmentOpen}>
                    <DialogTrigger asChild>
                      <Button variant="secondary">Create Adjustment Run</Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-lg">
                      <DialogHeader>
                        <DialogTitle>Create Adjustment Run</DialogTitle>
                      </DialogHeader>
                      <div className="grid gap-3 text-sm">
                        <p className="text-muted-foreground">
                          This keeps the finalized payroll intact and opens a new draft run for
                          corrections. Add notes for the audit trail.
                        </p>
                        <Textarea
                          placeholder="Reason for adjustment (optional)"
                          value={adjustmentNote}
                          onChange={(e) => setAdjustmentNote(e.target.value)}
                        />
                      </div>
                      <div className="flex justify-end">
                        <Button onClick={handleCreateAdjustment}>Create adjustment</Button>
                      </div>
                    </DialogContent>
                  </Dialog>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle>Employee Paystub Breakdown</CardTitle>
              <p className="text-xs text-muted-foreground">
                Current period with YTD totals per employee.
              </p>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead>Current Gross</TableHead>
                    <TableHead>Current Net</TableHead>
                    <TableHead>Current Tax</TableHead>
                    <TableHead>Current Pension</TableHead>
                <TableHead>YTD Gross</TableHead>
                <TableHead>YTD Net</TableHead>
                <TableHead>YTD Tax</TableHead>
                <TableHead>YTD Pension</TableHead>
                <TableHead>Print</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {run.payslips?.length ? (
                run.payslips.map((slip) => (
                  <TableRow key={slip.id}>
                    <TableCell>
                      {slip.employee.firstName} {slip.employee.lastName}
                        </TableCell>
                        <TableCell>{formatCurrency(Number(slip.grossPay || 0))}</TableCell>
                        <TableCell>{formatCurrency(Number(slip.netPay || 0))}</TableCell>
                        <TableCell>
                          {formatCurrency(getLineItem(slip, "tax"))}
                        </TableCell>
                        <TableCell>{formatCurrency(getLineItem(slip, "pension"))}</TableCell>
                        <TableCell>
                          {formatCurrency(
                            Number(run.ytdTotals?.[slip.employeeId]?.gross || 0)
                          )}
                        </TableCell>
                        <TableCell>
                          {formatCurrency(Number(run.ytdTotals?.[slip.employeeId]?.net || 0))}
                        </TableCell>
                        <TableCell>
                          {formatCurrency(
                            Number(run.ytdTotals?.[slip.employeeId]?.tax || 0)
                          )}
                        </TableCell>
                        <TableCell>
                          {formatCurrency(
                            Number(run.ytdTotals?.[slip.employeeId]?.pension || 0)
                          )}
                        </TableCell>
                        <TableCell>
                          <Button asChild size="sm" variant="secondary">
                            <Link href={`/admin/hr/paystubs/${slip.id}`}>Print</Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center text-sm text-muted-foreground">
                        No payslips recorded for this run.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </section>
  );
}
