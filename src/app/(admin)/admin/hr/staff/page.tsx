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
import Link from "next/link";

type Employee = {
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
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const statusTone: Record<Employee["status"], "default" | "secondary" | "destructive"> = {
  ACTIVE: "default",
  ON_LEAVE: "secondary",
  SUSPENDED: "destructive",
  TERMINATED: "secondary",
};

export default function AdminHrStaffPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importRows, setImportRows] = useState<Record<string, string>[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    department: "",
    position: "",
    status: "ACTIVE",
    hireDate: "",
    bankName: "",
    bankAccountName: "",
    bankAccountNumber: "",
    bankCode: "",
    bankBranch: "",
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
      const res = await fetch("/api/admin/hr/employees/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: importRows }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to import employees.");
        return;
      }
      toast.success(`Imported ${body.created} employee(s).`);
      if (body.skipped) {
        toast.success(`Skipped ${body.skipped} existing record(s).`);
      }
      if (Array.isArray(body.errors) && body.errors.length > 0) {
        toast.error(`Some rows failed: ${body.errors.length}.`);
      }
      setImportOpen(false);
      setImportRows([]);
      setImportErrors([]);
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "employees"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to import employees.");
    } finally {
      setImporting(false);
    }
  };

  const downloadTemplate = () => {
    const header =
      "firstName,lastName,email,phone,department,position,status,hireDate,bankName,bankAccountName,bankAccountNumber,bankCode,bankBranch";
    const sample =
      "Jane,Doe,jane.doe@example.com,0240000000,Finance,Accountant,ACTIVE,2025-01-10,Example Bank,Jane Doe,1234567890,EXB,Main";
    const csv = `${header}\n${sample}\n`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "employee-import-template.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  };

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (status !== "all") params.set("status", status);
    return `/api/admin/hr/employees?${params.toString()}`;
  }, [search, status]);

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "hr", "employees", search, status],
    queryFn: () => fetcher(query),
  });

  const rows = Array.isArray(data?.rows) ? (data.rows as Employee[]) : [];

  const handleCreate = async () => {
    try {
      const res = await fetch("/api/admin/hr/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to create employee.");
        return;
      }
      toast.success("Employee added.");
      setDialogOpen(false);
      setForm({
        firstName: "",
        lastName: "",
        email: "",
        phone: "",
        department: "",
        position: "",
        status: "ACTIVE",
        hireDate: "",
        bankName: "",
        bankAccountName: "",
        bankAccountNumber: "",
        bankCode: "",
        bankBranch: "",
      });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "employees"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to create employee.");
    }
  };

  const handleStatusUpdate = async (employeeId: string, nextStatus: Employee["status"]) => {
    try {
      const res = await fetch(`/api/admin/hr/employees/${employeeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to update status.");
        return;
      }
      toast.success("Status updated.");
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "employees"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to update status.");
    }
  };

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Staff Directory</h1>
          <p className="text-muted-foreground">Maintain employee profiles and status.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Employee profiles can be auto-linked when accounts are created in Users & Roles.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Dialog open={importOpen} onOpenChange={setImportOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">Import CSV</Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>Import Employees</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 text-sm">
                <p className="text-muted-foreground">
                  Upload a CSV with columns: firstName, lastName, email, phone, department,
                  position, status, hireDate (YYYY-MM-DD), bankName, bankAccountName,
                  bankAccountNumber, bankCode, bankBranch.
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
                  {importing ? "Importing..." : "Import employees"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button>+ Add Employee</Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>Add Employee</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  placeholder="First name"
                  value={form.firstName}
                  onChange={(e) => setForm((prev) => ({ ...prev, firstName: e.target.value }))}
                />
                <Input
                  placeholder="Last name"
                  value={form.lastName}
                  onChange={(e) => setForm((prev) => ({ ...prev, lastName: e.target.value }))}
                />
                <Input
                  placeholder="Email"
                  value={form.email}
                  onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
                />
                <Input
                  placeholder="Phone"
                  value={form.phone}
                  onChange={(e) => setForm((prev) => ({ ...prev, phone: e.target.value }))}
                />
                <Input
                  placeholder="Department"
                  value={form.department}
                  onChange={(e) => setForm((prev) => ({ ...prev, department: e.target.value }))}
                />
                <Input
                  placeholder="Position"
                  value={form.position}
                  onChange={(e) => setForm((prev) => ({ ...prev, position: e.target.value }))}
                />
                <Select
                  value={form.status}
                  onValueChange={(value) => setForm((prev) => ({ ...prev, status: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ACTIVE">Active</SelectItem>
                    <SelectItem value="ON_LEAVE">On leave</SelectItem>
                    <SelectItem value="SUSPENDED">Suspended</SelectItem>
                    <SelectItem value="TERMINATED">Terminated</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="date"
                  value={form.hireDate}
                  onChange={(e) => setForm((prev) => ({ ...prev, hireDate: e.target.value }))}
                />
                <Input
                  placeholder="Bank name"
                  value={form.bankName}
                  onChange={(e) => setForm((prev) => ({ ...prev, bankName: e.target.value }))}
                />
                <Input
                  placeholder="Bank code"
                  value={form.bankCode}
                  onChange={(e) => setForm((prev) => ({ ...prev, bankCode: e.target.value }))}
                />
                <Input
                  placeholder="Account name"
                  value={form.bankAccountName}
                  onChange={(e) => setForm((prev) => ({ ...prev, bankAccountName: e.target.value }))}
                />
                <Input
                  placeholder="Account number"
                  value={form.bankAccountNumber}
                  onChange={(e) => setForm((prev) => ({ ...prev, bankAccountNumber: e.target.value }))}
                />
                <Input
                  placeholder="Bank branch"
                  value={form.bankBranch}
                  onChange={(e) => setForm((prev) => ({ ...prev, bankBranch: e.target.value }))}
                />
              </div>
              <div className="flex justify-end">
                <Button onClick={handleCreate}>Save employee</Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </header>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Employees</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="Search staff"
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
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="ON_LEAVE">On leave</SelectItem>
                <SelectItem value="SUSPENDED">Suspended</SelectItem>
                <SelectItem value="TERMINATED">Terminated</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading staff...</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Position</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Contact</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                      No staff found.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Link
                          href={`/admin/hr/staff/${row.id}`}
                          className="font-medium underline-offset-2 hover:underline"
                        >
                          {row.firstName} {row.lastName}
                        </Link>
                        <div className="text-xs text-muted-foreground">
                          {row.hireDate
                            ? `Hired ${new Date(row.hireDate).toLocaleDateString()}`
                            : "—"}
                        </div>
                        {row.status === "TERMINATED" && row.terminationDate ? (
                          <div className="text-xs text-muted-foreground">
                            Terminated {new Date(row.terminationDate).toLocaleDateString()}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>{row.department || "—"}</TableCell>
                      <TableCell>{row.position || "—"}</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Badge variant={statusTone[row.status]}>
                            {row.status.replace("_", " ")}
                          </Badge>
                          <Select
                            value={row.status}
                            onValueChange={(value) =>
                              handleStatusUpdate(row.id, value as Employee["status"])
                            }
                          >
                            <SelectTrigger className="h-7 w-full sm:w-[150px] text-xs">
                              <SelectValue placeholder="Update status" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="ACTIVE">Active</SelectItem>
                              <SelectItem value="ON_LEAVE">On leave</SelectItem>
                              <SelectItem value="SUSPENDED">Suspended</SelectItem>
                              <SelectItem value="TERMINATED">Terminated</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{row.email || "—"}</div>
                        <div className="text-xs text-muted-foreground">{row.phone || ""}</div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
