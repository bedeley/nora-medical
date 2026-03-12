"use client";

import { useMemo, useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

type ScheduledReport = {
  id: string;
  name: string;
  reportType: "VAT" | "TRIAL_BALANCE" | "INTEGRITY" | "PL" | "BALANCE_SHEET";
  frequency: "WEEKLY" | "MONTHLY";
  recipients: string;
  enabled: boolean;
};

type SettingsPayload = {
  value: ScheduledReport[] | null;
};

export default function ScheduledReportsPage() {
  const { data, refetch } = useClientQuery<SettingsPayload>({
    queryKey: ["accounting", "scheduled-reports"],
    queryFn: () => fetch("/api/admin/settings/app?key=accounting.scheduledReports").then((r) => r.json()),
  });

  const current = useMemo(() => data?.value || [], [data]);
  const [name, setName] = useState("");
  const [reportType, setReportType] = useState<ScheduledReport["reportType"]>("VAT");
  const [frequency, setFrequency] = useState<ScheduledReport["frequency"]>("MONTHLY");
  const [recipients, setRecipients] = useState("");
  const [saving, setSaving] = useState(false);

  const saveSettings = async (next: ScheduledReport[]) => {
    try {
      setSaving(true);
      const res = await fetch("/api/admin/settings/app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "accounting.scheduledReports",
          value: next,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to save scheduled reports.");
      toast.success("Scheduled reports saved.");
      refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save scheduled reports.");
    } finally {
      setSaving(false);
    }
  };

  const addReport = async () => {
    if (!name.trim() || !recipients.trim()) {
      toast.error("Provide a name and recipient emails.");
      return;
    }
    const next: ScheduledReport[] = [
      {
        id: String(Date.now()),
        name: name.trim(),
        reportType,
        frequency,
        recipients: recipients.trim(),
        enabled: true,
      },
      ...current,
    ];
    await saveSettings(next);
    setName("");
    setRecipients("");
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Scheduled Reports</h1>
        <p className="text-sm text-muted-foreground">
          Configure report schedules and send report links by email.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add schedule</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Input placeholder="Schedule name" value={name} onChange={(e) => setName(e.target.value)} />
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm"
            value={reportType}
            onChange={(e) => setReportType(e.target.value as ScheduledReport["reportType"])}
          >
            <option value="VAT">VAT Filing</option>
            <option value="TRIAL_BALANCE">Trial Balance</option>
            <option value="PL">Profit & Loss</option>
            <option value="BALANCE_SHEET">Balance Sheet</option>
            <option value="INTEGRITY">Integrity Report</option>
          </select>
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as ScheduledReport["frequency"])}
          >
            <option value="MONTHLY">Monthly</option>
            <option value="WEEKLY">Weekly</option>
          </select>
          <Input
            placeholder="Recipients (comma-separated)"
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
          />
          <div className="sm:col-span-2 lg:col-span-3">
            <Button className="w-full sm:w-auto" onClick={addReport} disabled={saving}>
              {saving ? "Saving..." : "Add schedule"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Existing schedules</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          {current.length === 0 ? (
            <p className="text-muted-foreground">No scheduled reports yet.</p>
          ) : (
            current.map((report) => (
              <div key={report.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-2">
                <div>
                  <div className="font-medium">{report.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {report.reportType} · {report.frequency} · {report.recipients}
                  </div>
                </div>
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full sm:w-auto"
                    onClick={() => {
                      const next = current.map((item) =>
                        item.id === report.id ? { ...item, enabled: !item.enabled } : item,
                      );
                      void saveSettings(next);
                    }}
                    disabled={saving}
                  >
                    {report.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full sm:w-auto"
                    onClick={async () => {
                      try {
                        setSaving(true);
                        const res = await fetch("/api/admin/accounting/reports/scheduled/run", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ scheduleId: report.id }),
                        });
                        const j = await res.json().catch(() => ({}));
                        if (!res.ok) {
                          throw new Error(j?.error || "Failed to send report.");
                        }
                        toast.success("Report sent.");
                      } catch (e: unknown) {
                        toast.error(e instanceof Error ? e.message : "Failed to send report.");
                      } finally {
                        setSaving(false);
                      }
                    }}
                    disabled={saving || !report.enabled}
                  >
                    Send now
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full sm:w-auto"
                    onClick={() => {
                      const next = current.filter((item) => item.id !== report.id);
                      void saveSettings(next);
                    }}
                    disabled={saving}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </section>
  );
}
