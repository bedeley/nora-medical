"use client";

import { useState } from "react";
import Link from "next/link";
import { useClientQuery } from "@/hooks/use-client-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { formatDateGH } from "@/lib/currency";

type RequestRow = {
  id: string;
  requestType: "QUOTE" | "PO_UPLOAD" | "RECURRING_REORDER";
  status: "SUBMITTED" | "IN_REVIEW" | "QUOTED" | "APPROVED" | "REJECTED" | "CLOSED";
  clinicName: string;
  contactName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  notes: string | null;
  poDocumentUrl: string | null;
  templateId: string | null;
  itemsText: string | null;
  accountManagerId: string | null;
  createdAt: string;
  updatedAt: string;
};

type TemplateRow = {
  id: string;
  name: string;
  notes: string | null;
  itemsText: string;
  cadence: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "CUSTOM";
};
type AccountMe = {
  id: string;
  customerProfile?: "B2B" | "B2C";
  isB2B?: boolean;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function AccountProcurementPage() {
  const [creating, setCreating] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [requestType, setRequestType] = useState<"QUOTE" | "PO_UPLOAD" | "RECURRING_REORDER">("QUOTE");
  const [clinicName, setClinicName] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [poDocumentUrl, setPoDocumentUrl] = useState("");
  const [poFile, setPoFile] = useState<File | null>(null);
  const [uploadingPo, setUploadingPo] = useState(false);
  const [itemsText, setItemsText] = useState("");
  const [templateId, setTemplateId] = useState("");

  const [templateName, setTemplateName] = useState("");
  const [templateCadence, setTemplateCadence] = useState<"WEEKLY" | "BIWEEKLY" | "MONTHLY" | "CUSTOM">("MONTHLY");
  const [templateNotes, setTemplateNotes] = useState("");
  const [templateItemsText, setTemplateItemsText] = useState("");

  const { data: meData } = useClientQuery<AccountMe>({
    queryKey: ["account", "me", "procurement-profile"],
    queryFn: () => fetcher("/api/account/me"),
  });
  const isB2B = Boolean(meData?.isB2B);
  const { data: requestsData, refetch: refetchRequests, isFetching: requestsFetching } = useClientQuery<{ items: RequestRow[] }>({
    queryKey: ["account", "procurement-requests"],
    queryFn: () => fetcher("/api/account/procurement/requests"),
    enabled: isB2B,
  });
  const { data: templatesData, refetch: refetchTemplates } = useClientQuery<{ items: TemplateRow[] }>({
    queryKey: ["account", "procurement-templates"],
    queryFn: () => fetcher("/api/account/procurement/templates"),
    enabled: isB2B,
  });

  const requests = requestsData?.items || [];
  const templates = templatesData?.items || [];

  const createRequest = async () => {
    if (!clinicName.trim() || !contactName.trim()) {
      toast.error("Clinic and contact name are required.");
      return;
    }
    if (requestType === "PO_UPLOAD" && !poDocumentUrl.trim()) {
      toast.error("Upload a PO document before submitting.");
      return;
    }
    if (!itemsText.trim() && !templateId) {
      toast.error("Provide item list text or select a recurring template.");
      return;
    }
    try {
      setCreating(true);
      const res = await fetch("/api/account/procurement/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestType,
          clinicName: clinicName.trim(),
          contactName: contactName.trim(),
          contactPhone: contactPhone.trim() || undefined,
          contactEmail: contactEmail.trim() || undefined,
          notes: notes.trim() || undefined,
          poDocumentUrl: poDocumentUrl.trim() || undefined,
          templateId: templateId || undefined,
          itemsText: itemsText.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) {
        toast.error(body?.error || "Failed to submit request");
        return;
      }
      toast.success("Procurement request submitted.");
      await refetchRequests();
      setRequestType("QUOTE");
      setPoDocumentUrl("");
      setPoFile(null);
      setTemplateId("");
      setItemsText("");
      setNotes("");
    } finally {
      setCreating(false);
    }
  };

  const uploadPo = async () => {
    if (!poFile) {
      toast.error("Select a PO file first.");
      return;
    }
    try {
      setUploadingPo(true);
      const fd = new FormData();
      fd.append("file", poFile);
      const res = await fetch("/api/account/procurement/po-upload", {
        method: "POST",
        body: fd,
      });
      const body = await res.json().catch(() => ({} as { error?: string; url?: string; itemsText?: string; extractionMessage?: string }));
      if (!res.ok) {
        toast.error(body?.error || "PO upload failed");
        return;
      }
      if (!body?.url) {
        toast.error("Upload completed but no document URL was returned.");
        return;
      }
      setPoDocumentUrl(body.url);
      if (body.itemsText && body.itemsText.trim()) {
        setItemsText(body.itemsText);
        toast.success("PO uploaded and items were extracted. Review the Items box before submitting.");
      } else if (body.extractionMessage) {
        toast.success(body.extractionMessage);
      } else {
        toast.success("PO document uploaded.");
      }
    } finally {
      setUploadingPo(false);
    }
  };

  const createTemplate = async () => {
    if (!templateName.trim() || !templateItemsText.trim()) {
      toast.error("Template name and items are required.");
      return;
    }
    try {
      setSavingTemplate(true);
      const res = await fetch("/api/account/procurement/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: templateName.trim(),
          notes: templateNotes.trim() || undefined,
          itemsText: templateItemsText.trim(),
          cadence: templateCadence,
        }),
      });
      const body = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) {
        toast.error(body?.error || "Failed to save template");
        return;
      }
      toast.success("Reorder template saved.");
      await refetchTemplates();
      setTemplateName("");
      setTemplateNotes("");
      setTemplateItemsText("");
      setTemplateCadence("MONTHLY");
    } finally {
      setSavingTemplate(false);
    }
  };

  return (
    <section className="container mx-auto max-w-5xl py-8 space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Clinic Procurement Portal</h1>
          <p className="text-sm text-muted-foreground">
            Submit quote requests, upload POs, and manage recurring reorder templates.
          </p>
        </div>
        <Link href="/account">
          <Button variant="outline">Back to Account</Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">New Procurement Request</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isB2B ? (
            <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
              This account is configured as B2C. B2B procurement access must be enabled by an administrator.
            </div>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="mb-1 block text-sm font-medium">Request type</label>
              <Select value={requestType} onValueChange={(v: "QUOTE" | "PO_UPLOAD" | "RECURRING_REORDER") => setRequestType(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="QUOTE">Quote Request</SelectItem>
                  <SelectItem value="PO_UPLOAD">PO Upload</SelectItem>
                  <SelectItem value="RECURRING_REORDER">Recurring Reorder</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Clinic / Facility</label>
              <Input value={clinicName} onChange={(e) => setClinicName(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Contact name</label>
              <Input value={contactName} onChange={(e) => setContactName(e.target.value)} />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="mb-1 block text-sm font-medium">Contact phone</label>
              <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Contact email</label>
              <Input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Recurring template (optional)</label>
              <Select value={templateId || "__none__"} onValueChange={(v) => setTemplateId(v === "__none__" ? "" : v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="No template selected" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No template selected</SelectItem>
                  {templates.map((tpl) => (
                    <SelectItem key={tpl.id} value={tpl.id}>
                      {tpl.name} ({tpl.cadence})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {requestType === "PO_UPLOAD" ? (
            <div>
              <label className="mb-1 block text-sm font-medium">PO document</label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  type="file"
                  accept=".pdf,.doc,.docx,image/jpeg,image/png,image/webp"
                  onChange={(e) => setPoFile(e.target.files?.[0] || null)}
                />
                <Button type="button" variant="outline" onClick={uploadPo} disabled={uploadingPo || !poFile || !isB2B}>
                  {uploadingPo ? "Uploading..." : "Upload PO"}
                </Button>
              </div>
              {poDocumentUrl ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <a className="underline" href={poDocumentUrl} target="_blank" rel="noreferrer">
                    View uploaded PO
                  </a>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setPoDocumentUrl("");
                      setPoFile(null);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  Accepted: PDF/DOC/DOCX/JPG/PNG/WEBP up to 10MB.
                </p>
              )}
            </div>
          ) : null}

          <div>
            <label className="mb-1 block text-sm font-medium">Items (SKU, qty, notes)</label>
            <Textarea
              rows={5}
              value={itemsText}
              onChange={(e) => setItemsText(e.target.value)}
              placeholder={"Example:\nGLOVES-NITRILE-M: 20 boxes\nSYRINGE-5ML: 200 units"}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Additional notes</label>
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <div className="flex justify-end">
            <Button onClick={createRequest} disabled={creating || !isB2B}>
              {creating ? "Submitting..." : "Submit Request"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Recurring Reorder Templates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="mb-1 block text-sm font-medium">Template name</label>
              <Input value={templateName} onChange={(e) => setTemplateName(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Cadence</label>
              <Select value={templateCadence} onValueChange={(v: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "CUSTOM") => setTemplateCadence(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="WEEKLY">Weekly</SelectItem>
                  <SelectItem value="BIWEEKLY">Biweekly</SelectItem>
                  <SelectItem value="MONTHLY">Monthly</SelectItem>
                  <SelectItem value="CUSTOM">Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Template items</label>
            <Textarea rows={4} value={templateItemsText} onChange={(e) => setTemplateItemsText(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Notes</label>
            <Textarea rows={2} value={templateNotes} onChange={(e) => setTemplateNotes(e.target.value)} />
          </div>
          <div className="flex justify-end">
            <Button variant="outline" onClick={createTemplate} disabled={savingTemplate || !isB2B}>
              {savingTemplate ? "Saving..." : "Save Template"}
            </Button>
          </div>

          {templates.length > 0 ? (
            <div className="rounded border p-3 text-sm space-y-2">
              {templates.map((tpl) => (
                <div key={tpl.id} className="rounded border p-2">
                  <div className="font-medium">{tpl.name}</div>
                  <div className="text-xs text-muted-foreground">{tpl.cadence}</div>
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">My Procurement Requests</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex justify-end mb-3">
            <Button variant="outline" size="sm" onClick={() => refetchRequests()} disabled={requestsFetching}>
              {requestsFetching ? "Refreshing..." : "Refresh"}
            </Button>
          </div>
          {requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">No requests submitted yet.</p>
          ) : (
            <div className="space-y-2">
              {requests.map((row) => (
                <div key={row.id} className="rounded border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium">{row.clinicName}</div>
                    <div className="text-xs text-muted-foreground">{row.status}</div>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {row.requestType} - Updated {formatDateGH(row.updatedAt)}
                  </div>
                  {row.notes ? <div className="mt-2 text-xs">{row.notes}</div> : null}
                  {row.poDocumentUrl ? (
                    <a className="mt-2 inline-block text-xs underline" href={row.poDocumentUrl} target="_blank" rel="noreferrer">
                      Open PO document
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
