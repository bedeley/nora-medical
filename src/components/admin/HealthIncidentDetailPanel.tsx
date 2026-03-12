"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";

type IncidentStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";

type IncidentNote = {
  id: string;
  note: string;
  createdAt: string;
  createdByName: string;
};

type IncidentData = {
  id: string;
  fingerprint: string;
  issueCount: number;
  issueSummary: string;
  isManual: boolean;
  status: IncidentStatus;
  ownerId: string | null;
  ownerName: string | null;
  followUpDueAt: string | null;
  openedAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  openedByName: string | null;
  resolvedByName: string | null;
  notes: IncidentNote[];
};

type AdminOption = {
  id: string;
  name: string;
  email: string;
};

function fmt(value?: string | null) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

export default function HealthIncidentDetailPanel({
  initialIncident,
  admins,
}: {
  initialIncident: IncidentData;
  admins: AdminOption[];
}) {
  const router = useRouter();
  const [incident, setIncident] = useState<IncidentData>(initialIncident);
  const [status, setStatus] = useState<IncidentStatus>(initialIncident.status);
  const [ownerId, setOwnerId] = useState(initialIncident.ownerId || "");
  const [followUpDueAt, setFollowUpDueAt] = useState(
    initialIncident.followUpDueAt ? new Date(initialIncident.followUpDueAt).toISOString().slice(0, 10) : "",
  );
  const [workflowNote, setWorkflowNote] = useState("");
  const [newNote, setNewNote] = useState("");
  const [busy, setBusy] = useState<null | "workflow" | "note">(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [confirmWorkflow, setConfirmWorkflow] = useState(false);
  const [confirmReopen, setConfirmReopen] = useState(false);
  const [reopenStatus, setReopenStatus] = useState<"OPEN" | "IN_PROGRESS">("OPEN");
  const [reopenReason, setReopenReason] = useState("");
  const [falsePositiveReason, setFalsePositiveReason] = useState("");
  const [splitSummary, setSplitSummary] = useState("");
  const [mergeFromId, setMergeFromId] = useState("");
  const [confirmFalsePositive, setConfirmFalsePositive] = useState(false);
  const [confirmSplit, setConfirmSplit] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);

  const ownerLabel = useMemo(() => {
    if (!incident.ownerId) return "Unassigned";
    const owner = admins.find((a) => a.id === incident.ownerId);
    if (!owner) return incident.ownerName || "Assigned";
    return `${owner.name} (${owner.email})`;
  }, [admins, incident.ownerId, incident.ownerName]);

  const workflowNoteError =
    workflowNote.trim().length > 0 && workflowNote.trim().length < 8
      ? "Workflow note must be at least 8 characters."
      : "";
  const reopeningFromResolved = incident.status === "RESOLVED" && (status === "OPEN" || status === "IN_PROGRESS");
  const reopenFromResolvedError =
    reopeningFromResolved && workflowNote.trim().length < 8
      ? "Reopen reason is required (minimum 8 characters)."
      : "";
  const newNoteError =
    newNote.trim().length > 0 && newNote.trim().length < 8 ? "Incident note must be at least 8 characters." : "";
  const reopenReasonError =
    reopenReason.trim().length > 0 && reopenReason.trim().length < 8
      ? "Reopen reason must be at least 8 characters."
      : "";
  const isClosed = incident.status === "CLOSED";
  const falsePositiveReasonError =
    falsePositiveReason.trim().length > 0 && falsePositiveReason.trim().length < 8
      ? "False positive reason must be at least 8 characters."
      : "";
  const splitSummaryError =
    splitSummary.trim().length > 0 && splitSummary.trim().length < 8
      ? "Split summary must be at least 8 characters."
      : "";

  async function updateWorkflow(options?: { redirectToList?: boolean; reopen?: boolean }) {
    if (workflowNoteError || reopenFromResolvedError) return;
    setBusy("workflow");
    setStatusMessage("");
    try {
      const res = await fetch(`/api/admin/health/incidents/${incident.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          ownerId: ownerId || null,
          followUpDueAt: followUpDueAt || null,
          note: workflowNote.trim() || null,
          reopen: Boolean(options?.reopen),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = String(json?.error || "Failed to update incident workflow.");
        setStatusMessage(message);
        toast.error(message);
        return;
      }
      setIncident(json.incident as IncidentData);
      setWorkflowNote("");
      setStatusMessage("Incident workflow updated.");
      toast.success("Incident workflow updated.");
      if (options?.redirectToList) {
        router.push("/admin/health/incidents");
        router.refresh();
      }
    } catch {
      const message = "Failed to update incident workflow.";
      setStatusMessage(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }

  async function reopenIncident(options?: { redirectToList?: boolean }) {
    if (reopenReason.trim().length < 8) return;
    setBusy("workflow");
    setStatusMessage("");
    try {
      const res = await fetch(`/api/admin/health/incidents/${incident.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: reopenStatus,
          ownerId: ownerId || null,
          followUpDueAt: followUpDueAt || null,
          note: reopenReason.trim(),
          reopen: true,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = String(json?.error || "Failed to reopen incident.");
        setStatusMessage(message);
        toast.error(message);
        return;
      }
      setIncident(json.incident as IncidentData);
      setStatus(reopenStatus);
      setReopenReason("");
      setStatusMessage("Incident reopened.");
      toast.success("Incident reopened.");
      if (options?.redirectToList) {
        router.push("/admin/health/incidents");
        router.refresh();
      }
    } catch {
      const message = "Failed to reopen incident.";
      setStatusMessage(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }

  async function addNote() {
    if (newNote.trim().length < 8) return;
    setBusy("note");
    setStatusMessage("");
    try {
      const res = await fetch(`/api/admin/health/incidents/${incident.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: newNote.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = String(json?.error || "Failed to add incident note.");
        setStatusMessage(message);
        toast.error(message);
        return;
      }
      setIncident((prev) => ({
        ...prev,
        notes: [json.note as IncidentNote, ...prev.notes].slice(0, 50),
      }));
      setNewNote("");
      setStatusMessage("Incident note added.");
      toast.success("Incident note added.");
    } catch {
      const message = "Failed to add incident note.";
      setStatusMessage(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }

  async function markFalsePositive() {
    if (falsePositiveReason.trim().length < 8) return;
    setBusy("workflow");
    setStatusMessage("");
    try {
      const res = await fetch(`/api/admin/health/incidents/${incident.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_false_positive", reason: falsePositiveReason.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = String(json?.error || "Failed to mark false positive.");
        setStatusMessage(message);
        toast.error(message);
        return;
      }
      setIncident(json.incident as IncidentData);
      setStatus((json.incident as IncidentData).status);
      setFalsePositiveReason("");
      setStatusMessage("Incident marked as false positive and closed.");
      toast.success("Incident marked false positive.");
    } catch {
      const message = "Failed to mark false positive.";
      setStatusMessage(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }

  async function splitIncident() {
    if (splitSummary.trim().length < 8) return;
    setBusy("workflow");
    setStatusMessage("");
    try {
      const res = await fetch(`/api/admin/health/incidents/${incident.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "split", summary: splitSummary.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = String(json?.error || "Failed to split incident.");
        setStatusMessage(message);
        toast.error(message);
        return;
      }
      setSplitSummary("");
      setStatusMessage(`Split incident created: ${String(json?.splitIncidentId || "")}`);
      toast.success("Split incident created.");
      if (json?.splitIncidentLink) {
        router.push(String(json.splitIncidentLink));
        router.refresh();
      }
    } catch {
      const message = "Failed to split incident.";
      setStatusMessage(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }

  async function mergeIncident() {
    if (!mergeFromId.trim()) return;
    setBusy("workflow");
    setStatusMessage("");
    try {
      const res = await fetch(`/api/admin/health/incidents/${incident.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "merge_from", mergeFromId: mergeFromId.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = String(json?.error || "Failed to merge incident.");
        setStatusMessage(message);
        toast.error(message);
        return;
      }
      setIncident(json.incident as IncidentData);
      setMergeFromId("");
      setStatusMessage("Incident merged successfully.");
      toast.success("Incident merged.");
    } catch {
      const message = "Failed to merge incident.";
      setStatusMessage(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold">Health Incident</h1>
        <p className="text-sm text-muted-foreground">Manage this incident independently from the live health snapshot.</p>
        <div className="flex flex-wrap gap-2 text-xs">
          <Link href="/admin/health/incidents" className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-muted">
            Back to incidents
          </Link>
          <Link href="/admin/health" className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-muted">
            Back to health check
          </Link>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Incident snapshot</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{incident.status.replace(/_/g, " ")}</Badge>
            <span className="text-xs text-muted-foreground">{incident.isManual ? "Manual follow-up" : "Detector-backed"}</span>
          </div>
          <p><span className="text-muted-foreground">Issue summary:</span> {incident.issueSummary}</p>
          <p><span className="text-muted-foreground">Issue count:</span> {incident.issueCount}</p>
          <p><span className="text-muted-foreground">Fingerprint:</span> <span className="font-mono text-xs">{incident.fingerprint}</span></p>
          <p><span className="text-muted-foreground">Owner:</span> {ownerLabel}</p>
          <p><span className="text-muted-foreground">Opened:</span> {fmt(incident.openedAt)} by {incident.openedByName || "Not provided"}</p>
          <p><span className="text-muted-foreground">Resolved:</span> {fmt(incident.resolvedAt)} by {incident.resolvedByName || "-"}</p>
          <p><span className="text-muted-foreground">Closed:</span> {fmt(incident.closedAt)}</p>
          <p><span className="text-muted-foreground">Follow-up due:</span> {fmt(incident.followUpDueAt)}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Incident tools</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid gap-3 md:grid-cols-3">
            <label className="space-y-1 block">
              <span className="text-xs text-muted-foreground">Mark false positive</span>
              <Input
                placeholder="Reason"
                value={falsePositiveReason}
                onChange={(e) => setFalsePositiveReason(e.target.value)}
              />
              {falsePositiveReasonError ? <p className="text-xs text-red-600">{falsePositiveReasonError}</p> : null}
              <Button
                className="mt-1"
                variant="outline"
                disabled={busy !== null || falsePositiveReason.trim().length < 8 || Boolean(falsePositiveReasonError)}
                onClick={() => setConfirmFalsePositive(true)}
              >
                Mark false positive
              </Button>
            </label>

            <label className="space-y-1 block">
              <span className="text-xs text-muted-foreground">Split incident into follow-up</span>
              <Input
                placeholder="New follow-up summary"
                value={splitSummary}
                onChange={(e) => setSplitSummary(e.target.value)}
              />
              {splitSummaryError ? <p className="text-xs text-red-600">{splitSummaryError}</p> : null}
              <Button
                className="mt-1"
                variant="outline"
                disabled={busy !== null || splitSummary.trim().length < 8 || Boolean(splitSummaryError)}
                onClick={() => setConfirmSplit(true)}
              >
                Split incident
              </Button>
            </label>

            <label className="space-y-1 block">
              <span className="text-xs text-muted-foreground">Merge another incident into this</span>
              <Input
                placeholder="Source incident ID"
                value={mergeFromId}
                onChange={(e) => setMergeFromId(e.target.value)}
              />
              <Button
                className="mt-1"
                variant="outline"
                disabled={busy !== null || mergeFromId.trim().length < 6}
                onClick={() => setConfirmMerge(true)}
              >
                Merge source incident
              </Button>
            </label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Workflow controls</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Status</span>
              <select
                className="h-9 w-full rounded border bg-background px-2 text-sm"
                value={status}
                onChange={(e) => setStatus(e.target.value as IncidentStatus)}
                disabled={isClosed}
              >
                <option value="OPEN">Open</option>
                <option value="IN_PROGRESS">In progress</option>
                <option value="RESOLVED">Resolved</option>
                <option value="CLOSED">Closed</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Owner</span>
              <select
                className="h-9 w-full rounded border bg-background px-2 text-sm"
                value={ownerId}
                onChange={(e) => setOwnerId(e.target.value)}
                disabled={isClosed}
              >
                <option value="">Unassigned</option>
                {admins.map((admin) => (
                  <option key={admin.id} value={admin.id}>
                    {admin.name} ({admin.email})
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Follow-up due date</span>
              <Input type="date" value={followUpDueAt} onChange={(e) => setFollowUpDueAt(e.target.value)} />
            </label>
          </div>
          <label className="space-y-1 block">
            <span className="text-xs text-muted-foreground">Workflow note (optional)</span>
            <Input
              placeholder="Example: Assigned to finance for settlement verification."
              value={workflowNote}
              onChange={(e) => setWorkflowNote(e.target.value)}
              disabled={isClosed}
            />
          </label>
          {workflowNoteError ? <p className="text-xs text-red-600">{workflowNoteError}</p> : null}
          {reopenFromResolvedError ? <p className="text-xs text-red-600">{reopenFromResolvedError}</p> : null}
          {isClosed ? (
            <div className="space-y-2">
              <p className="text-xs text-amber-700">
                This incident is closed. Normal workflow edits are disabled.
              </p>
              <Button disabled={busy !== null} onClick={() => setConfirmReopen(true)}>
                Reopen closed incident
              </Button>
            </div>
          ) : null}
          <Button
            disabled={isClosed || busy !== null || Boolean(workflowNoteError) || Boolean(reopenFromResolvedError)}
            onClick={() => setConfirmWorkflow(true)}
          >
            {busy === "workflow" ? "Saving..." : "Update workflow"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Timeline notes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="space-y-1 block">
            <span className="text-xs text-muted-foreground">Add note</span>
            <textarea
              className="min-h-24 w-full rounded border bg-background px-2 py-2 text-sm"
              placeholder="Finding -> Action -> Outcome -> Next step"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
            />
          </label>
          {newNoteError ? <p className="text-xs text-red-600">{newNoteError}</p> : null}
          <Button disabled={busy !== null || newNote.trim().length < 8} onClick={() => void addNote()}>
            {busy === "note" ? "Saving..." : "Add note"}
          </Button>
          <div className="space-y-2">
            {incident.notes.length === 0 ? (
              <p className="text-muted-foreground">No notes yet.</p>
            ) : (
              incident.notes.map((entry) => (
                <div key={entry.id} className="rounded border p-2">
                  <p className="text-xs text-muted-foreground">
                    {fmt(entry.createdAt)} by {entry.createdByName}
                  </p>
                  <p>{entry.note}</p>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {statusMessage ? <p className="text-sm text-muted-foreground">{statusMessage}</p> : null}

      <Dialog open={confirmWorkflow} onOpenChange={setConfirmWorkflow}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply incident workflow update?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This updates status, owner, and due date for this incident and writes an audit log.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmWorkflow(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy !== null}
              onClick={async () => {
                setConfirmWorkflow(false);
                await updateWorkflow();
              }}
            >
              Confirm update
            </Button>
            <Button
              disabled={busy !== null}
              onClick={async () => {
                setConfirmWorkflow(false);
                await updateWorkflow({ redirectToList: true });
              }}
            >
              Confirm update & back
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmReopen} onOpenChange={setConfirmReopen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reopen closed incident?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Reopening requires a reason and writes a dedicated audit log entry.
            </p>
            <label className="space-y-1 block">
              <span className="text-xs text-muted-foreground">Reopen to status</span>
              <select
                className="h-9 w-full rounded border bg-background px-2 text-sm"
                value={reopenStatus}
                onChange={(e) => setReopenStatus((e.target.value || "OPEN") as "OPEN" | "IN_PROGRESS")}
              >
                <option value="OPEN">Open</option>
                <option value="IN_PROGRESS">In progress</option>
              </select>
            </label>
            <label className="space-y-1 block">
              <span className="text-xs text-muted-foreground">Reopen reason</span>
              <Input
                placeholder="Explain why this closed incident is being reopened."
                value={reopenReason}
                onChange={(e) => setReopenReason(e.target.value)}
              />
            </label>
            {reopenReasonError ? <p className="text-xs text-red-600">{reopenReasonError}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmReopen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy !== null || reopenReason.trim().length < 8 || Boolean(reopenReasonError)}
              onClick={async () => {
                setConfirmReopen(false);
                await reopenIncident();
              }}
            >
              Confirm reopen
            </Button>
            <Button
              disabled={busy !== null || reopenReason.trim().length < 8 || Boolean(reopenReasonError)}
              onClick={async () => {
                setConfirmReopen(false);
                await reopenIncident({ redirectToList: true });
              }}
            >
              Confirm reopen & back
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmFalsePositive} onOpenChange={setConfirmFalsePositive}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark incident as false positive?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This closes the incident and records the reason in timeline and audit log.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmFalsePositive(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy !== null || falsePositiveReason.trim().length < 8 || Boolean(falsePositiveReasonError)}
              onClick={async () => {
                setConfirmFalsePositive(false);
                await markFalsePositive();
              }}
            >
              Confirm false positive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmSplit} onOpenChange={setConfirmSplit}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Split incident into follow-up?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This creates a new follow-up incident and keeps this record as history.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmSplit(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy !== null || splitSummary.trim().length < 8 || Boolean(splitSummaryError)}
              onClick={async () => {
                setConfirmSplit(false);
                await splitIncident();
              }}
            >
              Confirm split
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmMerge} onOpenChange={setConfirmMerge}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge source incident into this one?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Source incident will be closed and this timeline will record the merge summary.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmMerge(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy !== null || mergeFromId.trim().length < 6}
              onClick={async () => {
                setConfirmMerge(false);
                await mergeIncident();
              }}
            >
              Confirm merge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
