"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import type { AuditRiskSettings, AuditSettingsMode } from "@/lib/audit-risk-config";

type SettingsResponse = {
  mode: AuditSettingsMode;
  editable: boolean;
  settings: AuditRiskSettings;
  defaults: AuditRiskSettings;
};

function asNumberText(value: number) {
  return Number.isFinite(value) ? String(value) : "";
}

function validatePositive(value: string, label: string) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return `${label} must be greater than 0.`;
  return "";
}

export default function AuditSettingsPage() {
  const { data, isLoading, refetch } = useClientQuery<SettingsResponse>({
    queryKey: ["admin", "audit", "settings"],
    queryFn: async () => {
      const response = await fetch("/api/admin/audit/settings");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Failed to load audit settings.");
      return payload as SettingsResponse;
    },
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: 60_000,
  });

  const [refundCriticalAmount, setRefundCriticalAmount] = useState("");
  const [refundHighAmount, setRefundHighAmount] = useState("");
  const [paymentVoidHighAmount, setPaymentVoidHighAmount] = useState("");
  const [otcShiftUnpostedHighCount, setOtcShiftUnpostedHighCount] = useState("");
  const [slaCritical, setSlaCritical] = useState("");
  const [slaHigh, setSlaHigh] = useState("");
  const [slaMedium, setSlaMedium] = useState("");
  const [archiveReminder, setArchiveReminder] = useState("");
  const [archiveEscalation, setArchiveEscalation] = useState("");
  const [ruleOrderCancelHigh, setRuleOrderCancelHigh] = useState<boolean | null>(null);
  const [ruleDeleteHigh, setRuleDeleteHigh] = useState<boolean | null>(null);
  const [ruleJournalUndoMedium, setRuleJournalUndoMedium] = useState<boolean | null>(null);
  const [ruleB2bNotifyFailMedium, setRuleB2bNotifyFailMedium] = useState<boolean | null>(null);
  const [ruleOtcOverrideHigh, setRuleOtcOverrideHigh] = useState<boolean | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const effective = data?.settings;
  const editable = Boolean(data?.editable);
  const mode = data?.mode || "editable";

  const draft = useMemo(() => {
    if (!effective) return null;
    return {
      refundCriticalAmount: refundCriticalAmount || asNumberText(effective.refundCriticalAmount),
      refundHighAmount: refundHighAmount || asNumberText(effective.refundHighAmount),
      paymentVoidHighAmount: paymentVoidHighAmount || asNumberText(effective.paymentVoidHighAmount),
      otcShiftUnpostedHighCount:
        otcShiftUnpostedHighCount || asNumberText(effective.otcShiftUnpostedHighCount),
      reviewSlaHours: {
        critical: slaCritical || asNumberText(effective.reviewSlaHours.critical),
        high: slaHigh || asNumberText(effective.reviewSlaHours.high),
        medium: slaMedium || asNumberText(effective.reviewSlaHours.medium),
      },
      archiveWindowDays: {
        reminder: archiveReminder || asNumberText(effective.archiveWindowDays.reminder),
        escalation: archiveEscalation || asNumberText(effective.archiveWindowDays.escalation),
      },
      actionRules: {
        orderCancelHigh: ruleOrderCancelHigh ?? effective.actionRules.orderCancelHigh,
        deleteHigh: ruleDeleteHigh ?? effective.actionRules.deleteHigh,
        journalArchiveUndoMedium:
          ruleJournalUndoMedium ?? effective.actionRules.journalArchiveUndoMedium,
        b2bNotificationFailureMedium:
          ruleB2bNotifyFailMedium ?? effective.actionRules.b2bNotificationFailureMedium,
        otcShiftOverrideHigh: ruleOtcOverrideHigh ?? effective.actionRules.otcShiftOverrideHigh,
      },
    };
  }, [
    effective,
    refundCriticalAmount,
    refundHighAmount,
    paymentVoidHighAmount,
    otcShiftUnpostedHighCount,
    slaCritical,
    slaHigh,
    slaMedium,
    archiveReminder,
    archiveEscalation,
    ruleOrderCancelHigh,
    ruleDeleteHigh,
    ruleJournalUndoMedium,
    ruleB2bNotifyFailMedium,
    ruleOtcOverrideHigh,
  ]);

  const inlineErrors = useMemo(() => {
    if (!draft) return [] as string[];
    const errors = [
      validatePositive(draft.refundCriticalAmount, "Refund critical amount"),
      validatePositive(draft.refundHighAmount, "Refund high amount"),
      validatePositive(draft.paymentVoidHighAmount, "Payment void high amount"),
      validatePositive(draft.otcShiftUnpostedHighCount, "Unposted OTC count"),
      validatePositive(draft.reviewSlaHours.critical, "Critical SLA (hours)"),
      validatePositive(draft.reviewSlaHours.high, "High SLA (hours)"),
      validatePositive(draft.reviewSlaHours.medium, "Medium SLA (hours)"),
      validatePositive(draft.archiveWindowDays.reminder, "Archive reminder (days)"),
      validatePositive(draft.archiveWindowDays.escalation, "Archive escalation (days)"),
    ].filter(Boolean) as string[];
    const critical = Number(draft.refundCriticalAmount);
    const high = Number(draft.refundHighAmount);
    if (Number.isFinite(critical) && Number.isFinite(high) && high > critical) {
      errors.push("Refund high amount cannot be greater than refund critical amount.");
    }
    const reminder = Number(draft.archiveWindowDays.reminder);
    const escalation = Number(draft.archiveWindowDays.escalation);
    if (Number.isFinite(reminder) && Number.isFinite(escalation) && escalation > reminder) {
      errors.push("Archive escalation days cannot be greater than archive reminder days.");
    }
    return errors;
  }, [draft]);

  const save = async (settingsOverride?: AuditRiskSettings) => {
    if (!settingsOverride && (!draft || inlineErrors.length > 0)) return;
    const payloadSettings =
      settingsOverride ||
      ({
        refundCriticalAmount: Number(draft!.refundCriticalAmount),
        refundHighAmount: Number(draft!.refundHighAmount),
        paymentVoidHighAmount: Number(draft!.paymentVoidHighAmount),
        otcShiftUnpostedHighCount: Number(draft!.otcShiftUnpostedHighCount),
        reviewSlaHours: {
          critical: Number(draft!.reviewSlaHours.critical),
          high: Number(draft!.reviewSlaHours.high),
          medium: Number(draft!.reviewSlaHours.medium),
        },
        archiveWindowDays: {
          reminder: Number(draft!.archiveWindowDays.reminder),
          escalation: Number(draft!.archiveWindowDays.escalation),
        },
        actionRules: {
          orderCancelHigh: draft!.actionRules.orderCancelHigh,
          deleteHigh: draft!.actionRules.deleteHigh,
          journalArchiveUndoMedium: draft!.actionRules.journalArchiveUndoMedium,
          b2bNotificationFailureMedium: draft!.actionRules.b2bNotificationFailureMedium,
          otcShiftOverrideHigh: draft!.actionRules.otcShiftOverrideHigh,
        },
      } as AuditRiskSettings);
    try {
      setSaving(true);
      const response = await fetch("/api/admin/audit/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: payloadSettings,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Failed to save settings.");
      toast.success(settingsOverride ? "Audit settings reset to defaults." : "Audit settings saved.");
      setConfirmOpen(false);
      setResetConfirmOpen(false);
      setRefundCriticalAmount("");
      setRefundHighAmount("");
      setPaymentVoidHighAmount("");
      setOtcShiftUnpostedHighCount("");
      setSlaCritical("");
      setSlaHigh("");
      setSlaMedium("");
      setArchiveReminder("");
      setArchiveEscalation("");
      setRuleOrderCancelHigh(null);
      setRuleDeleteHigh(null);
      setRuleJournalUndoMedium(null);
      setRuleB2bNotifyFailMedium(null);
      setRuleOtcOverrideHigh(null);
      refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save settings.");
    } finally {
      setSaving(false);
    }
  };

  if (isLoading && !data) {
    return (
      <section className="container mx-auto max-w-4xl py-6">
        <p className="text-sm text-muted-foreground">Loading audit settings...</p>
      </section>
    );
  }

  return (
    <section className="container mx-auto max-w-4xl space-y-4 py-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Audit Risk Settings</h1>
        <p className="text-sm text-muted-foreground">
          Configure review trigger thresholds and queue windows used by <Link href="/admin/audit" className="underline">Audit Log</Link>.
        </p>
      </header>

      <Card>
        <CardHeader className="space-y-2">
          <CardTitle>Control mode</CardTitle>
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="outline">Mode: {mode}</Badge>
            <Badge
              variant="outline"
              className={editable ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-amber-300 bg-amber-50 text-amber-800"}
            >
              {editable ? "Editable" : "Locked"}
            </Badge>
          </div>
          {!editable ? (
            <p className="text-xs text-amber-700">
              Editing is locked by <code>AUDIT_SETTINGS_MODE={mode}</code>.
            </p>
          ) : null}
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Risk thresholds</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Refund high amount</label>
            <Input
              inputMode="decimal"
              value={draft?.refundHighAmount || ""}
              onChange={(e) => setRefundHighAmount(e.target.value)}
              disabled={!editable}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Refund critical amount</label>
            <Input
              inputMode="decimal"
              value={draft?.refundCriticalAmount || ""}
              onChange={(e) => setRefundCriticalAmount(e.target.value)}
              disabled={!editable}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Payment void high amount</label>
            <Input
              inputMode="decimal"
              value={draft?.paymentVoidHighAmount || ""}
              onChange={(e) => setPaymentVoidHighAmount(e.target.value)}
              disabled={!editable}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">OTC unposted count (high)</label>
            <Input
              inputMode="numeric"
              value={draft?.otcShiftUnpostedHighCount || ""}
              onChange={(e) => setOtcShiftUnpostedHighCount(e.target.value)}
              disabled={!editable}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Review SLAs and archive queue</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Critical review SLA (hours)</label>
            <Input value={draft?.reviewSlaHours.critical || ""} onChange={(e) => setSlaCritical(e.target.value)} disabled={!editable} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">High review SLA (hours)</label>
            <Input value={draft?.reviewSlaHours.high || ""} onChange={(e) => setSlaHigh(e.target.value)} disabled={!editable} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Medium review SLA (hours)</label>
            <Input value={draft?.reviewSlaHours.medium || ""} onChange={(e) => setSlaMedium(e.target.value)} disabled={!editable} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Archive reminder (days)</label>
            <Input value={draft?.archiveWindowDays.reminder || ""} onChange={(e) => setArchiveReminder(e.target.value)} disabled={!editable} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Archive escalation (days)</label>
            <Input value={draft?.archiveWindowDays.escalation || ""} onChange={(e) => setArchiveEscalation(e.target.value)} disabled={!editable} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Risk rule matrix</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(draft?.actionRules.orderCancelHigh)}
              onChange={(e) => setRuleOrderCancelHigh(e.target.checked)}
              disabled={!editable}
            />
            Raise <code>ORDER_CANCEL</code> as High risk
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(draft?.actionRules.deleteHigh)}
              onChange={(e) => setRuleDeleteHigh(e.target.checked)}
              disabled={!editable}
            />
            Raise all <code>*DELETE*</code> actions as High risk
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(draft?.actionRules.journalArchiveUndoMedium)}
              onChange={(e) => setRuleJournalUndoMedium(e.target.checked)}
              disabled={!editable}
            />
            Raise <code>JOURNAL.ARCHIVE.UNDO</code> as Medium risk
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(draft?.actionRules.b2bNotificationFailureMedium)}
              onChange={(e) => setRuleB2bNotifyFailMedium(e.target.checked)}
              disabled={!editable}
            />
            Raise B2B customer notify failures as Medium risk
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(draft?.actionRules.otcShiftOverrideHigh)}
              onChange={(e) => setRuleOtcOverrideHigh(e.target.checked)}
              disabled={!editable}
            />
            Raise OTC shift close override as High risk
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 py-4">
          {inlineErrors.length > 0 ? (
            <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
              {inlineErrors[0]}
            </div>
          ) : (
            <div className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              Values look valid.
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={!editable || inlineErrors.length > 0} onClick={() => setConfirmOpen(true)}>
              Save audit settings
            </Button>
            <Button type="button" variant="outline" disabled={!editable || !data?.defaults} onClick={() => setResetConfirmOpen(true)}>
              Reset to defaults
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save audit risk settings?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This updates risk classification and review queue deadlines for new and existing audit rows.
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void save()} disabled={saving || inlineErrors.length > 0}>
              {saving ? "Saving..." : "Confirm save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset audit settings to defaults?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will restore all thresholds and queue windows to env/default values and save immediately.
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setResetConfirmOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (!data?.defaults) return;
                save(data.defaults);
              }}
              disabled={saving || !data?.defaults}
            >
              {saving ? "Resetting..." : "Confirm reset"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
