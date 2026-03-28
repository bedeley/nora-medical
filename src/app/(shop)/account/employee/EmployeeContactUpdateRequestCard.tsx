"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function EmployeeContactUpdateRequestCard({
  currentEmail,
  currentPhone,
  pendingRequest,
}: {
  currentEmail: string | null | undefined;
  currentPhone: string | null | undefined;
  pendingRequest:
    | {
        requestedEmail: string | null;
        requestedPhone: string | null;
        reason: string | null;
        status: "PENDING";
        requestedAt: string;
      }
    | null
    | undefined;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    email: currentEmail || "",
    phone: currentPhone || "",
    reason: "",
  });

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/account/employee/profile-update-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Unable to send update request.");
      }
      toast.success("Contact update request sent.");
      setOpen(false);
      setForm((prev) => ({ ...prev, reason: "" }));
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to send update request.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Card className="border shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>Need a contact change?</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Submit a request if your portal contact details need to be updated by HR.
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => setOpen(true)}>
            Request update
          </Button>
        </CardHeader>
        <CardContent>
          {pendingRequest ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/20">
              <p className="font-medium text-foreground">A contact update request is pending review.</p>
              <p className="mt-2 text-muted-foreground">
                Requested email: {pendingRequest.requestedEmail || "No email change requested"}
              </p>
              <p className="mt-1 text-muted-foreground">
                Requested phone: {pendingRequest.requestedPhone || "No phone change requested"}
              </p>
              <p className="mt-1 text-muted-foreground">
                Reason: {pendingRequest.reason || "No reason provided"}
              </p>
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              No contact update request is currently pending. Use the request button if your email or phone details
              need to change.
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Request contact update</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">Requested email</span>
              <Input value={form.email} onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))} />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">Requested phone</span>
              <Input value={form.phone} onChange={(e) => setForm((prev) => ({ ...prev, phone: e.target.value }))} />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">Reason</span>
              <Textarea
                rows={4}
                value={form.reason}
                onChange={(e) => setForm((prev) => ({ ...prev, reason: e.target.value }))}
                placeholder="Tell HR what changed and why this update is needed."
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={submitting} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="button" disabled={submitting} onClick={submit}>
                {submitting ? "Sending..." : "Send request"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
