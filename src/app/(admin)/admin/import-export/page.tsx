"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useClientQuery } from "@/hooks/use-client-query";
import { toast } from "sonner";

type ExportItem = {
  label: string;
  resource: string;
  url: string;
  note?: string;
  enabled?: boolean;
};

type ImportItem = {
  label: string;
  resource: string;
  template: string;
  note?: string;
  enabled?: boolean;
};

const exportItems: ExportItem[] = [
  { label: "Products", resource: "products", url: "/api/admin/import-export/export/products", enabled: true },
  { label: "Suppliers", resource: "suppliers", url: "/api/admin/import-export/export/suppliers", enabled: true },
  { label: "Customers", resource: "customers", url: "/api/admin/import-export/export/customers", enabled: true },
  { label: "Orders", resource: "orders", url: "/api/admin/import-export/export/orders", enabled: true },
  { label: "Purchases", resource: "purchases", url: "/api/admin/import-export/export/purchases", enabled: true },
  { label: "Payments", resource: "payments", url: "/api/admin/import-export/export/payments", enabled: true },
  {
    label: "Inventory",
    resource: "inventory",
    url: "/api/admin/import-export/export/inventory",
    enabled: true,
  },
  {
    label: "Inventory Lots",
    resource: "inventoryLots",
    url: "/api/admin/import-export/export/inventoryLots",
    enabled: true,
  },
  {
    label: "Inventory Planning",
    resource: "inventoryPlanning",
    url: "/api/admin/import-export/export/inventoryPlanning",
    enabled: true,
  },
  {
    label: "Inventory Planning (Suggestions)",
    resource: "inventoryPlanningSuggestions",
    url: "/api/admin/import-export/export/inventoryPlanningSuggestions",
    enabled: true,
  },
  {
    label: "Supplier Payments",
    resource: "supplierPayments",
    url: "/api/admin/import-export/export/supplierPayments",
    enabled: true,
  },
  {
    label: "Returns & RMA",
    resource: "returns",
    url: "/api/admin/import-export/export/returns",
    enabled: true,
  },
  {
    label: "Movements",
    resource: "movements",
    url: "/api/admin/import-export/export/movements",
    enabled: true,
  },
  {
    label: "Audit Log",
    resource: "audit",
    url: "/api/admin/import-export/export/audit",
    enabled: true,
  },
];

const importItems: ImportItem[] = [
  {
    label: "Products",
    resource: "products",
    template: "/api/admin/import-export/templates/products",
    note: "Bulk create or update product catalog.",
    enabled: true,
  },
  {
    label: "Suppliers",
    resource: "suppliers",
    template: "/api/admin/import-export/templates/suppliers",
    note: "Bulk create supplier records.",
    enabled: true,
  },
  {
    label: "Customers",
    resource: "customers",
    template: "/api/admin/import-export/templates/customers",
    note: "Import customers from Excel exports.",
    enabled: true,
  },
  {
    label: "Orders",
    resource: "orders",
    template: "/api/admin/import-export/templates/orders",
    note: "Backfill historical orders (admin only).",
    enabled: true,
  },
  {
    label: "Purchases",
    resource: "purchases",
    template: "/api/admin/import-export/templates/purchases",
    note: "Backfill purchases or PO history.",
    enabled: true,
  },
  {
    label: "Inventory Lots",
    resource: "inventoryLots",
    template: "/api/admin/import-export/templates/inventoryLots",
    note: "Batch/expiry tracking uploads.",
    enabled: true,
  },
  {
    label: "Payments",
    resource: "payments",
    template: "/api/admin/import-export/templates/payments",
    note: "Legacy payment reconciliation.",
    enabled: true,
  },
  {
    label: "Supplier Payments",
    resource: "supplierPayments",
    template: "/api/admin/import-export/templates/supplierPayments",
    note: "Backfill supplier payment history.",
    enabled: true,
  },
  {
    label: "Bank Transactions",
    resource: "bankTransactions",
    template: "/api/admin/import-export/templates/bankTransactions",
    note: "Import bank statement lines for reconciliation.",
    enabled: true,
  },
];

async function logAction(payload: {
  action: "EXPORT" | "IMPORT" | "TEMPLATE";
  resource: string;
  format?: string;
  url?: string;
}) {
  await fetch("/api/admin/import-export/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export default function ImportExportCenterPage() {
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();
  const role = session?.user?.role;
  const isAdmin = role === "ADMIN";
  const [logBusy, setLogBusy] = useState<string | null>(null);
  const [filesByResource, setFilesByResource] = useState<Record<string, File | null>>({});
  const [sourceFilesByResource, setSourceFilesByResource] = useState<Record<string, File | null>>({});
  const [bankSelections, setBankSelections] = useState<Record<string, string>>({});
  const [reportByResource, setReportByResource] = useState<
    Record<string, { issues: Array<{ row: number; reason: string }> } | null>
  >({});
  const [dryRunByResource, setDryRunByResource] = useState<Record<string, boolean>>({});
  const [extractBusyByResource, setExtractBusyByResource] = useState<Record<string, boolean>>({});
  const importCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const focusImport = (searchParams.get("focusImport") || "").trim();
  const preselectedBankId = (searchParams.get("bankId") || "").trim();

  const { data: banksData } = useClientQuery<{ id: string; name: string }[]>({
    queryKey: ["accounting", "banks"],
    queryFn: () => fetch("/api/admin/accounting/banks").then((r) => r.json()),
    enabled: isAdmin,
  });
  const banks = useMemo(() => (Array.isArray(banksData) ? banksData : []), [banksData]);

  const groupedExports = useMemo(() => {
    return exportItems.map((item) => ({
      ...item,
      key: `${item.resource}:${item.url}`,
    }));
  }, []);

  const handleExport = async (item: ExportItem) => {
    if (item.enabled === false) {
      toast.info("Export is coming soon for this dataset.");
      return;
    }
    setLogBusy(item.resource);
    try {
      await logAction({ action: "EXPORT", resource: item.resource, format: "csv", url: item.url });
      window.open(item.url, "_blank");
    } catch {
      toast.error("Export blocked or unavailable for your role.");
    } finally {
      setLogBusy(null);
    }
  };

  const handleTemplate = async (item: ImportItem) => {
    setLogBusy(item.resource);
    try {
      await logAction({ action: "TEMPLATE", resource: item.resource, format: "csv", url: item.template });
      window.open(item.template, "_blank");
    } catch {
      toast.error("Template download blocked or unavailable for your role.");
    } finally {
      setLogBusy(null);
    }
  };

  const handleImport = async (item: ImportItem) => {
    if (!item.enabled) {
      toast.info("Import is coming soon for this dataset.");
      return;
    }
    const file = filesByResource[item.resource];
    if (!file) {
      toast.error("Select a CSV file first.");
      return;
    }
    setLogBusy(item.resource);
    try {
      const formData = new FormData();
      formData.append("file", file);
      if (item.resource === "bankTransactions") {
        const selectedBank = bankSelections[item.resource] || "";
        if (!selectedBank) {
          toast.error("Select a bank account.");
          return;
        }
        formData.append("bankId", selectedBank);
      }
      const dryRun = Boolean(dryRunByResource[item.resource]);
      formData.append("dryRun", dryRun ? "1" : "0");
      const res = await fetch(`/api/admin/import-export/import/${item.resource}`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error || "Import failed");
      }
      const payload = await res.json().catch(() => null);
      setReportByResource((prev) => ({
        ...prev,
        [item.resource]: payload?.issues ? { issues: payload.issues } : null,
      }));
      toast.success(
        payload?.message ||
          `${dryRun ? "Dry run" : "Import"} complete. Added ${payload?.created ?? 0}, updated ${
            payload?.updated ?? 0
          }.`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setLogBusy(null);
    }
  };

  const handleExtract = async (item: ImportItem) => {
    const sourceFile = sourceFilesByResource[item.resource];
    if (!sourceFile) {
      toast.error("Select a source file first (PDF, image, DOCX, TXT, or CSV).");
      return;
    }
    setExtractBusyByResource((prev) => ({ ...prev, [item.resource]: true }));
    try {
      const formData = new FormData();
      formData.append("file", sourceFile);
      if (item.resource === "bankTransactions") {
        const selectedBankId = bankSelections[item.resource] || "";
        const selectedBank = banks.find((bank) => bank.id === selectedBankId);
        if (selectedBank?.name) formData.append("bankName", selectedBank.name);
      }
      const res = await fetch(`/api/admin/import-export/extract/${item.resource}`, {
        method: "POST",
        body: formData,
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.error || "Failed to extract structured rows.");
      }
      const csvText = String(payload?.csv || "");
      if (!csvText) throw new Error("Extraction returned empty CSV.");
      const derivedFile = new File([csvText], `${item.resource}-extracted.csv`, {
        type: "text/csv",
      });
      setFilesByResource((prev) => ({ ...prev, [item.resource]: derivedFile }));
      if (Array.isArray(payload?.warnings) && payload.warnings.length > 0) {
        toast.success(
          `Extracted ${payload?.mappedRows ?? 0} row(s). Warnings present; run Dry run before import.`,
        );
      } else {
        toast.success(`Extracted ${payload?.mappedRows ?? 0} row(s) into import-ready CSV.`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Assisted extraction failed.");
    } finally {
      setExtractBusyByResource((prev) => ({ ...prev, [item.resource]: false }));
    }
  };

  useEffect(() => {
    if (isAdmin || status === "loading") return;
    const timer = setTimeout(() => {
      window.location.href = "/unauthorized";
    }, 1200);
    return () => clearTimeout(timer);
  }, [isAdmin, status]);

  useEffect(() => {
    if (focusImport !== "bankTransactions") return;
    if (!preselectedBankId) return;
    if (!banks.some((bank) => bank.id === preselectedBankId)) return;
    setBankSelections((prev) => {
      if (prev.bankTransactions === preselectedBankId) return prev;
      return { ...prev, bankTransactions: preselectedBankId };
    });
  }, [focusImport, preselectedBankId, banks]);

  useEffect(() => {
    if (!focusImport) return;
    const target = importCardRefs.current[focusImport];
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusImport, status]);

  if (status === "loading") {
    return (
      <section className="container mx-auto py-8">
        <p className="text-sm text-muted-foreground">Loading import/export center...</p>
      </section>
    );
  }

  if (!isAdmin) {
    return (
      <section className="container mx-auto py-8">
        <Card>
          <CardHeader>
            <CardTitle>Not authorized</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Redirecting you to the access denied page…
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="container mx-auto py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Import / Export Center</h1>
        <p className="text-sm text-muted-foreground">
          Centralized CSV tools with audit logs for every import/export. Built for Excel-first workflows.
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          CSV downloads will open in Excel if it is your default CSV app. You can also open Excel and import
          the CSV files manually.
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          Page-level exports include your current filters/date range. The exports here are full datasets.
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          Access depends on your role. If an action is blocked, ask an admin to grant import/export access.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Exports</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
          {groupedExports.map((item) => (
            <div key={item.key} className="rounded-md border p-3 flex flex-col gap-2">
              <div className="font-medium">{item.label}</div>
              {item.note ? (
                <p className="text-xs text-muted-foreground">{item.note}</p>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleExport(item)}
                disabled={logBusy === item.resource}
              >
                {logBusy === item.resource ? "Preparing..." : "Export CSV"}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Imports</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
          {importItems.map((item) => (
            <div
              key={item.resource}
              ref={(node) => {
                importCardRefs.current[item.resource] = node;
              }}
              className="rounded-md border p-3 flex flex-col gap-2"
            >
              <div className="font-medium">
                {item.label}
                {focusImport === item.resource ? (
                  <span className="ml-2 rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Recommended
                  </span>
                ) : null}
              </div>
              {item.note ? (
                <p className="text-xs text-muted-foreground">{item.note}</p>
              ) : null}
              {item.resource === "bankTransactions" ? (
                <select
                  className="h-9 rounded-md border bg-background px-2 text-xs"
                  value={bankSelections[item.resource] || ""}
                  onChange={(event) =>
                    setBankSelections((prev) => ({ ...prev, [item.resource]: event.target.value }))
                  }
                  disabled={!item.enabled}
                >
                  <option value="">Select bank</option>
                  {banks.map((bank) => (
                    <option key={bank.id} value={bank.id}>
                      {bank.name}
                    </option>
                  ))}
                </select>
              ) : null}
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={Boolean(dryRunByResource[item.resource])}
                  onChange={(event) =>
                    setDryRunByResource((prev) => ({
                      ...prev,
                      [item.resource]: event.target.checked,
                    }))
                  }
                  disabled={!item.enabled}
                />
                Dry run (validate only)
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  className="w-full sm:w-auto"
                  size="sm"
                  variant="outline"
                  onClick={() => handleTemplate(item)}
                  disabled={logBusy === item.resource}
                >
                  {logBusy === item.resource ? "Preparing..." : "Download template"}
                </Button>
                <input
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.txt,.csv,text/csv,application/pdf,image/*"
                  disabled={!item.enabled}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0] ?? null;
                    setSourceFilesByResource((prev) => ({ ...prev, [item.resource]: file }));
                  }}
                  className="text-xs"
                />
                <Button
                  className="w-full sm:w-auto"
                  size="sm"
                  variant="outline"
                  onClick={() => handleExtract(item)}
                  disabled={Boolean(extractBusyByResource[item.resource]) || !item.enabled}
                >
                  {extractBusyByResource[item.resource] ? "Extracting..." : "Extract to CSV (beta)"}
                </Button>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  disabled={!item.enabled}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0] ?? null;
                    setFilesByResource((prev) => ({ ...prev, [item.resource]: file }));
                  }}
                  className="text-xs"
                />
                <Button
                  className="w-full sm:w-auto"
                  size="sm"
                  onClick={() => handleImport(item)}
                  disabled={logBusy === item.resource || !item.enabled}
                >
                  {item.enabled ? "Import" : "Import (coming soon)"}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Assisted extraction supports PDF/image/DOCX/TXT/CSV and creates an import-ready CSV candidate.
                Always use Dry run before final import.
              </p>
              {reportByResource[item.resource]?.issues?.length ? (
                <div className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground space-y-1">
                  <div className="font-medium text-foreground">Skipped rows</div>
                  {reportByResource[item.resource]?.issues.slice(0, 5).map((issue) => (
                    <div key={`${item.resource}-${issue.row}-${issue.reason}`}>
                      Row {issue.row}: {issue.reason}
                    </div>
                  ))}
                  {(reportByResource[item.resource]?.issues?.length ?? 0) > 5 ? (
                    <div>+{(reportByResource[item.resource]?.issues?.length ?? 0) - 5} more...</div>
                  ) : null}
                  <div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const issues = reportByResource[item.resource]?.issues || [];
                        const header = "row,reason";
                        const lines = issues.map((issue) => `${issue.row},"${issue.reason.replace(/"/g, '""')}"`);
                        const csv = `${header}\n${lines.join("\n")}\n`;
                        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
                        const url = window.URL.createObjectURL(blob);
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = `${item.resource}-import-issues.csv`;
                        document.body.appendChild(link);
                        link.click();
                        link.remove();
                        window.URL.revokeObjectURL(url);
                      }}
                    >
                      Download error report
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}
