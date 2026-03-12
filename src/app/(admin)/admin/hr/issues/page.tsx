"use client";

export const dynamic = "force-dynamic";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

type Employee = {
  id: string;
  firstName: string;
  lastName: string;
};

type StaffIssue = {
  id: string;
  employeeId: string;
  employee?: { firstName: string; lastName: string } | null;
  type: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";
  description: string;
  createdAt: string;
  closedAt?: string | null;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function AdminHrIssuesPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({
    employeeId: "",
    type: "",
    severity: "LOW",
    status: "OPEN",
    description: "",
  });

  const { data: employeesData } = useQuery({
    queryKey: ["admin", "hr", "employees"],
    queryFn: () => fetcher("/api/admin/hr/employees"),
  });
  const { data: issuesData } = useQuery({
    queryKey: ["admin", "hr", "issues"],
    queryFn: () => fetcher("/api/admin/hr/issues"),
  });

  const employees = Array.isArray(employeesData?.rows) ? (employeesData.rows as Employee[]) : [];
  const issues = Array.isArray(issuesData?.rows) ? (issuesData.rows as StaffIssue[]) : [];

  const handleCreateIssue = async () => {
    try {
      const res = await fetch("/api/admin/hr/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to create staff issue.");
        return;
      }
      toast.success("Staff issue logged.");
      setDialogOpen(false);
      setForm({ employeeId: "", type: "", severity: "LOW", status: "OPEN", description: "" });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "issues"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to create staff issue.");
    }
  };

  const handleIssueStatusUpdate = async (issueId: string, status: StaffIssue["status"]) => {
    try {
      const res = await fetch(`/api/admin/hr/issues/${issueId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to update status.");
        return;
      }
      toast.success("Issue updated.");
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "issues"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to update status.");
    }
  };

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Staff Issues</h1>
          <p className="text-muted-foreground">Track and resolve HR cases.</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>+ Log Issue</Button>
          </DialogTrigger>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>New Staff Issue</DialogTitle>
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
                placeholder="Issue type (e.g. Salary dispute)"
                value={form.type}
                onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value }))}
              />
              <Select
                value={form.severity}
                onValueChange={(value) => setForm((prev) => ({ ...prev, severity: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Severity" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="LOW">Low</SelectItem>
                  <SelectItem value="MEDIUM">Medium</SelectItem>
                  <SelectItem value="HIGH">High</SelectItem>
                  <SelectItem value="CRITICAL">Critical</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={form.status}
                onValueChange={(value) => setForm((prev) => ({ ...prev, status: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="OPEN">Open</SelectItem>
                  <SelectItem value="IN_PROGRESS">In progress</SelectItem>
                  <SelectItem value="RESOLVED">Resolved</SelectItem>
                  <SelectItem value="CLOSED">Closed</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="Description"
                value={form.description}
                onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
              />
            </div>
            <div className="flex justify-end">
              <Button onClick={handleCreateIssue}>Save issue</Button>
            </div>
          </DialogContent>
        </Dialog>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Logged Issues</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
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
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                    No staff issues logged yet.
                  </TableCell>
                </TableRow>
              ) : (
                issues.map((issue) => {
                  const employee = issue.employee || employees.find((e) => e.id === issue.employeeId);
                  return (
                    <TableRow key={issue.id}>
                      <TableCell>
                        {employee ? `${employee.firstName} ${employee.lastName}` : "—"}
                      </TableCell>
                      <TableCell>{issue.type}</TableCell>
                      <TableCell>{issue.severity}</TableCell>
                      <TableCell>
                        <Select
                          value={issue.status}
                          onValueChange={(value) =>
                            handleIssueStatusUpdate(issue.id, value as StaffIssue["status"])
                          }
                        >
                          <SelectTrigger className="h-7 w-full sm:w-[150px] text-xs">
                            <SelectValue placeholder="Status" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="OPEN">Open</SelectItem>
                            <SelectItem value="IN_PROGRESS">In progress</SelectItem>
                            <SelectItem value="RESOLVED">Resolved</SelectItem>
                            <SelectItem value="CLOSED">Closed</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>{new Date(issue.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell>
                        {issue.closedAt ? new Date(issue.closedAt).toLocaleDateString() : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </section>
  );
}
