"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { logAdminExportDownload } from "@/lib/admin-export-audit-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";

type BankAccount = {
  id: string;
  name: string;
  bankName?: string | null;
  accountNumberMasked?: string | null;
  currency: string;
  isActive: boolean;
};

type BankTxn = {
  id: string;
  postedAt: string;
  amount: number | string;
  description?: string | null;
  reference?: string | null;
  type: "DEBIT" | "CREDIT";
  matched: boolean;
};

type LedgerAccount = {
  id: string;
  code: string;
  name: string;
};

type BankMatchRule = {
  id: string;
  name: string;
  matchText: string;
  matchMode: "CONTAINS" | "STARTS_WITH" | "ENDS_WITH" | "REGEX";
  accountId?: string | null;
  account?: LedgerAccount | null;
  minAmount?: number | string | null;
  maxAmount?: number | string | null;
  amountTolerance?: number | string | null;
  priority?: number | string | null;
  isActive: boolean;
};

type BankImportRun = {
  id: string;
  at: string;
  actor: string;
  created: number;
  updated: number;
  skipped: number;
  issuesCount: number;
  issuesPreview?: Array<{ row: number; reason: string }>;
};

type BankImportRunDetails = {
  id: string;
  at: string;
  actor: string;
  created: number;
  updated: number;
  skipped: number;
  issuesCount: number;
  issuesPreview: Array<{ row: number; reason: string }>;
  issuesList: Array<{ row: number; reason: string }>;
  outcomePreview: {
    created: Array<{ row: number; bankName?: string; date?: string; amount?: string; reference?: string }>;
    updated: Array<{ row: number; bankName?: string; date?: string; amount?: string; reference?: string }>;
    skipped: Array<{ row: number; reason?: string }>;
  };
};

type SavedTxnFilter = {
  id: string;
  name: string;
  search: string;
  unmatchedOnly: boolean;
  fromDate: string;
  toDate: string;
  pageSize: number;
  sortBy: TransactionSortBy;
  sortDir: TransactionSortDir;
};

type BulkActionType = "DEBIT" | "CREDIT";
type TransactionSortBy = "postedAt" | "amount" | "type" | "description" | "reference" | "matched";
type TransactionSortDir = "asc" | "desc";

type RuleEvaluation = {
  matched: boolean;
  checks: string[];
};

type TransactionListResponse = {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  sortBy: TransactionSortBy;
  sortDir: TransactionSortDir;
  summary: {
    total: number;
    matched: number;
    unmatched: number;
  };
  rows: BankTxn[];
};

function escapeCsv(value: string) {
  if (!value) return "";
  if (/[\",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

async function fetchJsonOrThrow<T>(input: string): Promise<T> {
  const res = await fetch(input, { cache: "no-store" });
  const payload = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
  if (!res.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String(payload.error || `Request failed (${res.status})`)
        : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return payload as T;
}

function formatBankDate(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString(undefined, { timeZone: "UTC" });
}

function bankDateKey(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function evaluateRule(txn: BankTxn, rule: BankMatchRule): RuleEvaluation {
  const checks: string[] = [];
  if (!rule.isActive) return { matched: false, checks: ["Rule is inactive."] };
  const text = `${txn.description || ""} ${txn.reference || ""}`.toLowerCase();
  const needle = rule.matchText.toLowerCase();
  let textMatched = false;
  switch (rule.matchMode) {
    case "STARTS_WITH":
      textMatched = text.startsWith(needle);
      checks.push(textMatched ? "Text starts with rule text." : "Text does not start with rule text.");
      break;
    case "ENDS_WITH":
      textMatched = text.endsWith(needle);
      checks.push(textMatched ? "Text ends with rule text." : "Text does not end with rule text.");
      break;
    case "REGEX":
      try {
        textMatched = new RegExp(rule.matchText, "i").test(text);
        checks.push(textMatched ? "Regex matched." : "Regex did not match.");
      } catch {
        checks.push("Regex is invalid.");
        textMatched = false;
      }
      break;
    default:
      textMatched = text.includes(needle);
      checks.push(textMatched ? "Text contains rule text." : "Text does not contain rule text.");
  }
  const amount = Math.abs(Number(txn.amount || 0));
  const tol = rule.amountTolerance === null || rule.amountTolerance === undefined ? 0 : Math.max(0, Number(rule.amountTolerance));
  const min = rule.minAmount === null || rule.minAmount === undefined ? null : Number(rule.minAmount);
  const max = rule.maxAmount === null || rule.maxAmount === undefined ? null : Number(rule.maxAmount);
  const effectiveMin = min !== null && Number.isFinite(min) ? min - tol : null;
  const effectiveMax = max !== null && Number.isFinite(max) ? max + tol : null;
  let amountMatched = true;
  if (effectiveMin !== null && amount < effectiveMin) {
    amountMatched = false;
    checks.push(`Amount ${amount.toFixed(2)} is below min ${Number(min).toFixed(2)} (tol ±${tol.toFixed(2)}).`);
  }
  if (effectiveMax !== null && amount > effectiveMax) {
    amountMatched = false;
    checks.push(`Amount ${amount.toFixed(2)} is above max ${Number(max).toFixed(2)} (tol ±${tol.toFixed(2)}).`);
  }
  if (amountMatched) checks.push(tol > 0 ? `Amount range matched (tol ±${tol.toFixed(2)}).` : "Amount range matched.");
  return { matched: textMatched && amountMatched, checks };
}

export default function BankAccountsPage() {
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = session?.user?.role === "ADMIN";
  const {
    data,
    isError: banksIsError,
    error: banksError,
  } = useClientQuery<BankAccount[]>({
    queryKey: ["accounting", "banks"],
    queryFn: () => fetchJsonOrThrow<BankAccount[]>("/api/admin/accounting/banks"),
  });
  const {
    data: accountsData,
    isError: accountsIsError,
    error: accountsError,
  } = useClientQuery<LedgerAccount[]>({
    queryKey: ["accounting", "accounts"],
    queryFn: () => fetchJsonOrThrow<LedgerAccount[]>("/api/admin/accounting/accounts"),
  });
  const banks = useMemo(() => (Array.isArray(data) ? data : []), [data]);

  const [selectedBankId, setSelectedBankId] = useState("");
  const activeBank = useMemo(
    () => banks.find((b) => b.id === selectedBankId) || null,
    [banks, selectedBankId],
  );

  const {
    data: rulesData,
    isLoading: rulesLoading,
    isError: rulesIsError,
    error: rulesError,
  } = useClientQuery<BankMatchRule[]>({
    queryKey: ["accounting", "bank-rules", activeBank?.id],
    queryFn: () => fetchJsonOrThrow<BankMatchRule[]>(`/api/admin/accounting/banks/${activeBank?.id}/rules`),
    enabled: Boolean(activeBank?.id),
  });
  const rules = useMemo(() => (Array.isArray(rulesData) ? rulesData : []), [rulesData]);
  const {
    data: importRunsData,
    isError: importRunsIsError,
    error: importRunsError,
  } = useClientQuery<BankImportRun[]>({
    queryKey: ["accounting", "bank-import-runs", activeBank?.id],
    queryFn: () => fetchJsonOrThrow<BankImportRun[]>(`/api/admin/accounting/banks/${activeBank?.id}/import-runs`),
    enabled: Boolean(activeBank?.id),
  });
  const importRuns = useMemo(
    () => (Array.isArray(importRunsData) ? importRunsData : []),
    [importRunsData],
  );

  const [showAddBankForm, setShowAddBankForm] = useState(false);
  const [bankName, setBankName] = useState("");
  const [accountName, setAccountName] = useState("");
  const [accountMasked, setAccountMasked] = useState("");

  const [postedAt, setPostedAt] = useState("");
  const [amount, setAmount] = useState("");
  const [type, setType] = useState<"DEBIT" | "CREDIT">("CREDIT");
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [bankSaving, setBankSaving] = useState(false);
  const [ruleSaving, setRuleSaving] = useState(false);
  const [duplicateConflict, setDuplicateConflict] = useState<{ id: string; message: string } | null>(null);
  const [duplicateReason, setDuplicateReason] = useState("");
  const [transactionSearch, setTransactionSearch] = useState("");
  const [unmatchedOnly, setUnmatchedOnly] = useState(false);
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [selectedTxnIds, setSelectedTxnIds] = useState<string[]>([]);
  const [selectedTxnForRuleTestId, setSelectedTxnForRuleTestId] = useState("");
  const [highlightTxnId, setHighlightTxnId] = useState("");
  const [editingTxnId, setEditingTxnId] = useState("");
  const [editPostedAt, setEditPostedAt] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editType, setEditType] = useState<"DEBIT" | "CREDIT">("CREDIT");
  const [editDescription, setEditDescription] = useState("");
  const [editReference, setEditReference] = useState("");
  const [editingSave, setEditingSave] = useState(false);
  const [editOverrideDialogOpen, setEditOverrideDialogOpen] = useState(false);
  const [editOverrideReason, setEditOverrideReason] = useState("");
  const [editOverrideHint, setEditOverrideHint] = useState("");
  const [bulkSaving, setBulkSaving] = useState(false);
  const [savedFilters, setSavedFilters] = useState<SavedTxnFilter[]>([]);
  const [selectedSavedFilterId, setSelectedSavedFilterId] = useState("");
  const [saveFilterDialogOpen, setSaveFilterDialogOpen] = useState(false);
  const [saveFilterName, setSaveFilterName] = useState("");
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);
  const [pendingRuleDelete, setPendingRuleDelete] = useState<BankMatchRule | null>(null);
  const [deletingTxnId, setDeletingTxnId] = useState("");
  const [txnFromDate, setTxnFromDate] = useState("");
  const [txnToDate, setTxnToDate] = useState("");
  const [txnSortBy, setTxnSortBy] = useState<TransactionSortBy>("postedAt");
  const [txnSortDir, setTxnSortDir] = useState<TransactionSortDir>("desc");
  const [exportingCsvScope, setExportingCsvScope] = useState<"" | "filtered" | "all">("");
  const [debouncedFilteredTxns, setDebouncedFilteredTxns] = useState<BankTxn[]>([]);

  // Rule edit state
  const [editingRuleId, setEditingRuleId] = useState("");
  const [editRuleName, setEditRuleName] = useState("");
  const [editRuleText, setEditRuleText] = useState("");
  const [editRuleMode, setEditRuleMode] = useState<BankMatchRule["matchMode"]>("CONTAINS");
  const [editRuleAccountId, setEditRuleAccountId] = useState("");
  const [editRuleMin, setEditRuleMin] = useState("");
  const [editRuleMax, setEditRuleMax] = useState("");
  const [editRuleTolerance, setEditRuleTolerance] = useState("0.00");
  const [editRulePriority, setEditRulePriority] = useState("0");
  const [editRuleActive, setEditRuleActive] = useState(true);
  const [editRuleSaving, setEditRuleSaving] = useState(false);

  const [ruleName, setRuleName] = useState("");
  const [ruleText, setRuleText] = useState("");
  const [ruleMode, setRuleMode] = useState<BankMatchRule["matchMode"]>("CONTAINS");
  const [ruleAccountId, setRuleAccountId] = useState("");
  const [ruleMin, setRuleMin] = useState("");
  const [ruleMax, setRuleMax] = useState("");
  const [ruleTolerance, setRuleTolerance] = useState("0.00");
  const [rulePriority, setRulePriority] = useState("0");
  const [ruleActive, setRuleActive] = useState(true);
  const [importing, setImporting] = useState(false);
  const [downloadingIssuesRunId, setDownloadingIssuesRunId] = useState("");
  const [expandedRunId, setExpandedRunId] = useState("");
  const [loadingRunDetailsId, setLoadingRunDetailsId] = useState("");
  const [runDetailsById, setRunDetailsById] = useState<Record<string, BankImportRunDetails>>({});
  const [editingBankName, setEditingBankName] = useState("");
  const [editingBankLegalName, setEditingBankLegalName] = useState("");
  const [editingAccountMasked, setEditingAccountMasked] = useState("");
  const [editingBankActive, setEditingBankActive] = useState(true);
  const [bankProfileEditMode, setBankProfileEditMode] = useState(false);
  const [bankProfileSaveDialogOpen, setBankProfileSaveDialogOpen] = useState(false);
  const [bankProfileSaving, setBankProfileSaving] = useState(false);

  const transactionQuery = useMemo(() => {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    params.set("sortBy", txnSortBy);
    params.set("sortDir", txnSortDir);
    if (transactionSearch.trim()) params.set("q", transactionSearch.trim());
    if (unmatchedOnly) params.set("unmatchedOnly", "1");
    if (txnFromDate) params.set("from", txnFromDate);
    if (txnToDate) params.set("to", txnToDate);
    return params.toString();
  }, [page, pageSize, txnSortBy, txnSortDir, transactionSearch, unmatchedOnly, txnFromDate, txnToDate]);

  const {
    data: transactionsData,
    isLoading: txnsLoading,
    isError: txnsIsError,
    error: txnsError,
  } = useClientQuery<TransactionListResponse>({
    queryKey: ["accounting", "bank-transactions", activeBank?.id, transactionQuery],
    queryFn: () =>
      fetchJsonOrThrow<TransactionListResponse>(
        `/api/admin/accounting/banks/${activeBank?.id}/transactions?${transactionQuery}`,
      ),
    enabled: Boolean(activeBank?.id),
  });
  const transactions = useMemo(
    () => (Array.isArray(transactionsData?.rows) ? transactionsData.rows : []),
    [transactionsData],
  );
  const transactionSummary = transactionsData?.summary ?? { total: 0, matched: 0, unmatched: 0 };
  const totalPages = transactionsData?.totalPages ?? 1;

  const storageKey = useMemo(
    () => `accounting-banks-filters-${activeBank?.id || "none"}`,
    [activeBank?.id],
  );

  useEffect(() => {
    const requestedBankId = String(searchParams.get("bankId") || "").trim();
    if (!requestedBankId) return;
    if (!banks.some((b) => b.id === requestedBankId)) return;
    setSelectedBankId(requestedBankId);
  }, [banks, searchParams]);

  useEffect(() => {
    setSelectedTxnIds([]);
    setPage(1);
    setEditingTxnId("");
    setSelectedTxnForRuleTestId("");
    setDuplicateConflict(null);
    setDuplicateReason("");
    setExpandedRunId("");
    setEditOverrideDialogOpen(false);
    setEditOverrideReason("");
    setEditOverrideHint("");
    setEditingRuleId("");
    setDeletingTxnId("");
    setTxnFromDate("");
    setTxnToDate("");
  }, [activeBank?.id]);

  useEffect(() => {
    setEditingBankName(activeBank?.name || "");
    setEditingBankLegalName(activeBank?.bankName || "");
    setEditingAccountMasked(activeBank?.accountNumberMasked || "");
    setEditingBankActive(Boolean(activeBank?.isActive ?? true));
    setBankProfileEditMode(false);
    setBankProfileSaveDialogOpen(false);
  }, [activeBank?.id, activeBank?.name, activeBank?.bankName, activeBank?.accountNumberMasked, activeBank?.isActive]);

  const bankProfileDirty = useMemo(() => {
    if (!activeBank) return false;
    return (
      editingBankName.trim() !== String(activeBank.name || "").trim() ||
      editingBankLegalName.trim() !== String(activeBank.bankName || "").trim() ||
      editingAccountMasked.trim() !== String(activeBank.accountNumberMasked || "").trim() ||
      editingBankActive !== Boolean(activeBank.isActive)
    );
  }, [activeBank, editingBankName, editingBankLegalName, editingAccountMasked, editingBankActive]);

  useEffect(() => {
    setPage(1);
  }, [transactionSearch, unmatchedOnly, pageSize, txnFromDate, txnToDate, txnSortBy, txnSortDir]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        setSavedFilters([]);
        setSelectedSavedFilterId("");
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        setSavedFilters([]);
        return;
      }
      const normalized: SavedTxnFilter[] = parsed
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          id: String(item.id || ""),
          name: String(item.name || "Untitled"),
          search: String(item.search || ""),
          unmatchedOnly: Boolean(item.unmatchedOnly),
          fromDate: String(item.fromDate || ""),
          toDate: String(item.toDate || ""),
          pageSize: Number(item.pageSize || 20),
          sortBy: ["postedAt", "amount", "type", "description", "reference", "matched"].includes(
            String(item.sortBy || ""),
          )
            ? (String(item.sortBy) as TransactionSortBy)
            : "postedAt",
          sortDir: (String(item.sortDir || "").toLowerCase() === "asc" ? "asc" : "desc") as TransactionSortDir,
        }))
        .filter((item) => item.id);
      setSavedFilters(normalized);
      setSelectedSavedFilterId("");
    } catch {
      setSavedFilters([]);
      setSelectedSavedFilterId("");
    }
  }, [storageKey]);

  const visibleTxnIds = useMemo(() => transactions.map((txn) => txn.id), [transactions]);
  const selectedTxns = useMemo(
    () => transactions.filter((txn) => selectedTxnIds.includes(txn.id)),
    [transactions, selectedTxnIds],
  );
  const selectedTxnForRuleTest = useMemo(
    () => transactions.find((txn) => txn.id === selectedTxnForRuleTestId) || null,
    [transactions, selectedTxnForRuleTestId],
  );

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    setSelectedTxnIds((prev) => prev.filter((id) => visibleTxnIds.includes(id)));
  }, [visibleTxnIds]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedFilteredTxns(transactions), 400);
    return () => clearTimeout(timer);
  }, [transactions]);

  const simulator = useMemo(() => {
    const sample = debouncedFilteredTxns;
    const activeRules = rules.filter((rule) => rule.isActive);
    const sampleCount = sample.length;
    if (sampleCount === 0 || activeRules.length === 0) {
      return {
        sampleCount,
        activeRules,
        overlapCount: 0,
        byRule: [] as Array<{ rule: BankMatchRule; matchedCount: number; matchRate: number }>,
        accountPreview: [] as Array<{ account: string; matchedCount: number }>,
      };
    }

    const matchedRuleCountByTxn = new Map<string, number>();
    const byRule = activeRules
      .map((rule) => {
        let matchedCount = 0;
        for (const txn of sample) {
          if (!evaluateRule(txn, rule).matched) continue;
          matchedCount += 1;
          matchedRuleCountByTxn.set(txn.id, Number(matchedRuleCountByTxn.get(txn.id) || 0) + 1);
        }
        return {
          rule,
          matchedCount,
          matchRate: matchedCount / sampleCount,
        };
      })
      .sort((a, b) => b.matchRate - a.matchRate || b.matchedCount - a.matchedCount);

    const overlapCount = Array.from(matchedRuleCountByTxn.values()).filter((count) => count > 1).length;
    const accountMap = new Map<string, number>();
    for (const item of byRule) {
      const accountName = item.rule.account?.name;
      if (!accountName || item.matchedCount <= 0) continue;
      accountMap.set(accountName, Number(accountMap.get(accountName) || 0) + item.matchedCount);
    }
    const accountPreview = Array.from(accountMap.entries())
      .map(([account, matchedCount]) => ({ account, matchedCount }))
      .sort((a, b) => b.matchedCount - a.matchedCount);

    return { sampleCount, activeRules, overlapCount, byRule, accountPreview };
  }, [debouncedFilteredTxns, rules]);

  const conflictInspector = useMemo(() => {
    const sample = debouncedFilteredTxns;
    const activeRules = rules.filter((rule) => rule.isActive);
    const pairCounts = new Map<string, number>();

    for (const txn of sample) {
      const matchedRules = activeRules.filter((rule) => evaluateRule(txn, rule).matched);
      if (matchedRules.length < 2) continue;
      for (let i = 0; i < matchedRules.length; i += 1) {
        for (let j = i + 1; j < matchedRules.length; j += 1) {
          const first = matchedRules[i];
          const second = matchedRules[j];
          const key = [first.id, second.id].sort().join("::");
          pairCounts.set(key, Number(pairCounts.get(key) || 0) + 1);
        }
      }
    }

    return Array.from(pairCounts.entries())
      .map(([key, count]) => {
        const [a, b] = key.split("::");
        const ra = activeRules.find((rule) => rule.id === a);
        const rb = activeRules.find((rule) => rule.id === b);
        if (!ra || !rb) return null;
        return {
          key,
          count,
          left: ra,
          right: rb,
        };
      })
      .filter((item): item is { key: string; count: number; left: BankMatchRule; right: BankMatchRule } => Boolean(item))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [debouncedFilteredTxns, rules]);

  const createBank = async () => {
    if (!accountName.trim()) {
      toast.error("Account name is required.");
      return;
    }
    try {
      setBankSaving(true);
      const res = await fetch("/api/admin/accounting/banks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: accountName.trim(),
          bankName: bankName.trim() || undefined,
          accountNumberMasked: accountMasked.trim() || undefined,
          currency: "GHS",
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to create bank account");
      toast.success("Bank account added.");
      setBankName("");
      setAccountName("");
      setAccountMasked("");
      setShowAddBankForm(false);
      queryClient.invalidateQueries({ queryKey: ["accounting", "banks"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create bank account.");
    } finally {
      setBankSaving(false);
    }
  };

  const addTransaction = async (opts?: { allowDuplicate?: boolean }) => {
    if (!activeBank?.id) {
      toast.error("Select a bank account first.");
      return;
    }
    const numericAmount = Number(amount);
    if (!postedAt || !Number.isFinite(numericAmount) || numericAmount === 0) {
      toast.error("Enter a valid date and amount.");
      return;
    }
    if (opts?.allowDuplicate && duplicateReason.trim().length < 8) {
      toast.error("Provide a duplicate reason with at least 8 characters.");
      return;
    }
    try {
      setBankSaving(true);
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          postedAt,
          amount: numericAmount,
          type,
          description: description.trim() || undefined,
          reference: reference.trim() || undefined,
          allowDuplicate: Boolean(opts?.allowDuplicate),
          duplicateReason: opts?.allowDuplicate ? duplicateReason.trim() : undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409 && j?.duplicateId) {
          setDuplicateConflict({
            id: String(j.duplicateId),
            message: String(j.error || "Potential duplicate transaction found."),
          });
        }
        throw new Error(j?.error || "Failed to add transaction");
      }
      toast.success(opts?.allowDuplicate ? "Duplicate override transaction added." : "Transaction added.");
      setPostedAt("");
      setAmount("");
      setDescription("");
      setReference("");
      setDuplicateConflict(null);
      setDuplicateReason("");
      queryClient.invalidateQueries({
        queryKey: ["accounting", "bank-transactions", activeBank.id],
      });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to add transaction.");
    } finally {
      setBankSaving(false);
    }
  };

  const startEditTransaction = (txn: BankTxn) => {
    if (txn.matched) {
      toast.error("Matched transactions are locked. Unmatch first.");
      return;
    }
    setEditingTxnId(txn.id);
    setEditPostedAt(bankDateKey(txn.postedAt));
    setEditAmount(String(Number(txn.amount).toFixed(2)));
    setEditType(txn.type);
    setEditDescription(txn.description || "");
    setEditReference(txn.reference || "");
  };

  const saveEditTransaction = async (opts?: { overrideEditLock?: boolean }) => {
    if (!activeBank?.id || !editingTxnId) return;
    const numericAmount = Number(editAmount);
    if (!editPostedAt || !Number.isFinite(numericAmount) || numericAmount === 0) {
      toast.error("Enter a valid date and amount for edit.");
      return;
    }
    if (opts?.overrideEditLock && editOverrideReason.trim().length < 8) {
      toast.error("Override reason must be at least 8 characters.");
      return;
    }
    try {
      setEditingSave(true);
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}/transactions/${editingTxnId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          postedAt: editPostedAt,
          amount: numericAmount,
          type: editType,
          description: editDescription.trim() || null,
          reference: editReference.trim() || null,
          overrideEditLock: Boolean(opts?.overrideEditLock),
          overrideReason: opts?.overrideEditLock ? editOverrideReason.trim() : undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 423 && j?.code === "EDIT_LOCKED_AGE_WINDOW") {
        if (j?.canSelfOverride) {
          setEditOverrideHint(
            String(
              j?.error ||
                "This transaction is outside the edit window. Admin override reason is required.",
            ),
          );
          setEditOverrideDialogOpen(true);
          return;
        }
        throw new Error(String(j?.error || "Transaction edit is locked and requires ADMIN override."));
      }
      if (!res.ok) throw new Error(j?.error || "Failed to save transaction changes.");
      toast.success("Transaction updated.");
      setEditingTxnId("");
      setEditOverrideDialogOpen(false);
      setEditOverrideReason("");
      setEditOverrideHint("");
      queryClient.invalidateQueries({ queryKey: ["accounting", "bank-transactions", activeBank.id] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save transaction.");
    } finally {
      setEditingSave(false);
    }
  };

  const toggleTxnSelection = (txnId: string, nextChecked: boolean) => {
    setSelectedTxnIds((prev) => {
      if (nextChecked) return Array.from(new Set([...prev, txnId]));
      return prev.filter((id) => id !== txnId);
    });
  };

  const toggleAllVisibleTxns = (nextChecked: boolean) => {
    if (nextChecked) {
      setSelectedTxnIds((prev) => Array.from(new Set([...prev, ...visibleTxnIds])));
      return;
    }
    setSelectedTxnIds((prev) => prev.filter((id) => !visibleTxnIds.includes(id)));
  };

  const exportSelectedTransactionsCsv = () => {
    if (!selectedTxns.length) {
      toast.error("Select at least one transaction to export.");
      return;
    }
    exportTransactionsCsv(selectedTxns, `bank-transactions-selected-${activeBank?.id || "selected"}.csv`);
  };

  const exportTransactionsCsv = (rows: BankTxn[], filename: string) => {
    const header = ["date", "type", "amount", "description", "reference", "matched"];
    const csvRows = rows.map((txn) => [
      bankDateKey(txn.postedAt),
      txn.type,
      Number(txn.amount).toFixed(2),
      txn.description || "",
      txn.reference || "",
      txn.matched ? "true" : "false",
    ]);
    const csv = [header, ...csvRows]
      .map((row) => row.map((cell) => escapeCsv(String(cell))).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    void logAdminExportDownload({
      area: "accounting-bank-transactions-selected",
      format: "CSV",
      fileName: filename,
      sourcePage: "admin/accounting/banks",
      scopeSnapshot: `Bank: ${activeBank?.name || activeBank?.id || "selected"} · Selected rows export`,
      resultSummary: `Exported ${rows.length} selected bank transaction row(s).`,
      rowCount: rows.length,
      columnCount: header.length,
      byteSize: blob.size,
      matchingCount: rows.length,
      totalCount: transactionSummary.total,
      sortKey: txnSortBy,
      sortDir: txnSortDir,
    });
  };

  const exportServerTransactionsCsv = async (scope: "filtered" | "all") => {
    if (!activeBank?.id) {
      toast.error("Select a bank account first.");
      return;
    }
    try {
      setExportingCsvScope(scope);
      const params = new URLSearchParams();
      params.set("format", "csv");
      params.set("sourcePage", "admin/accounting/banks");
      params.set("sortBy", txnSortBy);
      params.set("sortDir", txnSortDir);
      if (scope === "filtered") {
        if (transactionSearch.trim()) params.set("q", transactionSearch.trim());
        if (unmatchedOnly) params.set("unmatchedOnly", "1");
        if (txnFromDate) params.set("from", txnFromDate);
        if (txnToDate) params.set("to", txnToDate);
      }
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}/transactions?${params.toString()}`);
      if (!res.ok) {
        const payload = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
        throw new Error(payload?.error || "Failed to export CSV.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download =
        scope === "filtered"
          ? `bank-transactions-filtered-${activeBank.id}.csv`
          : `bank-transactions-all-${activeBank.id}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to export CSV.");
    } finally {
      setExportingCsvScope("");
    }
  };

  const runTxnBulkAction = async (
    action: "SET_TYPE" | "DELETE",
    typeValue?: BulkActionType,
    opts?: { confirmedDelete?: boolean },
  ) => {
    if (!activeBank?.id || !selectedTxnIds.length) {
      toast.error("Select at least one transaction first.");
      return;
    }
    if (action === "DELETE" && !opts?.confirmedDelete) {
      setBulkDeleteDialogOpen(true);
      return;
    }
    try {
      setBulkSaving(true);
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}/transactions/bulk`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: selectedTxnIds,
          action,
          ...(typeValue ? { type: typeValue } : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Bulk action failed.");
      toast.success(
        action === "DELETE"
          ? `Deleted ${Number(j?.deleted || 0)} transaction(s).`
          : `Updated ${Number(j?.updated || 0)} transaction(s).`,
      );
      setSelectedTxnIds([]);
      queryClient.invalidateQueries({
        queryKey: ["accounting", "bank-transactions", activeBank.id],
      });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Bulk action failed.");
    } finally {
      setBulkSaving(false);
    }
  };

  const saveFilters = (next: SavedTxnFilter[]) => {
    setSavedFilters(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    }
  };

  const applySavedFilter = (filterId: string) => {
    setSelectedSavedFilterId(filterId);
    const found = savedFilters.find((item) => item.id === filterId);
    if (!found) return;
    setTransactionSearch(found.search);
    setUnmatchedOnly(found.unmatchedOnly);
    setTxnFromDate(found.fromDate);
    setTxnToDate(found.toDate);
    setPageSize(found.pageSize);
    setTxnSortBy(found.sortBy);
    setTxnSortDir(found.sortDir);
    setPage(1);
  };

  const saveCurrentFilter = () => {
    setSaveFilterName("");
    setSaveFilterDialogOpen(true);
  };

  const confirmSaveCurrentFilter = () => {
    const trimmed = saveFilterName.trim();
    if (!trimmed) return;
    const id = `f_${Date.now()}`;
    const next: SavedTxnFilter[] = [
      ...savedFilters,
      {
        id,
        name: trimmed,
        search: transactionSearch,
        unmatchedOnly,
        fromDate: txnFromDate,
        toDate: txnToDate,
        pageSize,
        sortBy: txnSortBy,
        sortDir: txnSortDir,
      },
    ];
    saveFilters(next);
    setSelectedSavedFilterId(id);
    setSaveFilterDialogOpen(false);
    setSaveFilterName("");
    toast.success("Filter saved.");
  };

  const deleteSavedFilter = () => {
    if (!selectedSavedFilterId) {
      toast.error("Select a saved filter first.");
      return;
    }
    const next = savedFilters.filter((item) => item.id !== selectedSavedFilterId);
    saveFilters(next);
    setSelectedSavedFilterId("");
    toast.success("Saved filter removed.");
  };

  const openDuplicateExisting = (duplicateId: string) => {
    setTransactionSearch("");
    setUnmatchedOnly(false);
    setTxnFromDate("");
    setTxnToDate("");
    setPage(1);
    setSelectedTxnForRuleTestId(duplicateId);
    setHighlightTxnId(duplicateId);
    setTimeout(() => setHighlightTxnId(""), 2500);
  };

  const createRule = async () => {
    if (!activeBank?.id) {
      toast.error("Select a bank account first.");
      return;
    }
    if (!ruleName.trim() || !ruleText.trim()) {
      toast.error("Provide a rule name and match text.");
      return;
    }
    const minAmount = ruleMin === "" ? null : Number(ruleMin);
    const maxAmount = ruleMax === "" ? null : Number(ruleMax);
    const tolerance = ruleTolerance === "" ? 0 : Number(ruleTolerance);
    const priority = rulePriority === "" ? 0 : Number(rulePriority);
    if (ruleMin !== "" && !Number.isFinite(minAmount as number)) {
      toast.error("Enter a valid minimum amount.");
      return;
    }
    if (ruleMax !== "" && !Number.isFinite(maxAmount as number)) {
      toast.error("Enter a valid maximum amount.");
      return;
    }
    if (!Number.isFinite(tolerance)) {
      toast.error("Enter a valid tolerance.");
      return;
    }
    if (!Number.isFinite(priority)) {
      toast.error("Enter a valid priority.");
      return;
    }
    try {
      setRuleSaving(true);
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: ruleName.trim(),
          matchText: ruleText.trim(),
          matchMode: ruleMode,
          accountId: ruleAccountId || null,
          minAmount,
          maxAmount,
          amountTolerance: tolerance,
          priority,
          isActive: ruleActive,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to create rule.");
      toast.success("Match rule saved.");
      setRuleName("");
      setRuleText("");
      setRuleMode("CONTAINS");
      setRuleAccountId("");
      setRuleMin("");
      setRuleMax("");
      setRuleTolerance("0.00");
      setRulePriority("0");
      setRuleActive(true);
      queryClient.invalidateQueries({ queryKey: ["accounting", "bank-rules", activeBank.id] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create rule.");
    } finally {
      setRuleSaving(false);
    }
  };

  const toggleRule = async (rule: BankMatchRule) => {
    if (!activeBank?.id) return;
    try {
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}/rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to update rule.");
      queryClient.invalidateQueries({ queryKey: ["accounting", "bank-rules", activeBank.id] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update rule.");
    }
  };

  const bumpRulePriority = async (rule: BankMatchRule, delta: number) => {
    if (!activeBank?.id) return;
    const next = Number(rule.priority || 0) + delta;
    try {
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}/rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: next }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to update priority.");
      queryClient.invalidateQueries({ queryKey: ["accounting", "bank-rules", activeBank.id] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update priority.");
    }
  };

  const deleteRule = async (rule: BankMatchRule) => {
    setPendingRuleDelete(rule);
  };

  const startEditRule = (rule: BankMatchRule) => {
    setEditingRuleId(rule.id);
    setEditRuleName(rule.name);
    setEditRuleText(rule.matchText);
    setEditRuleMode(rule.matchMode);
    setEditRuleAccountId(rule.accountId || "");
    setEditRuleMin(rule.minAmount === null || rule.minAmount === undefined ? "" : String(Number(rule.minAmount)));
    setEditRuleMax(rule.maxAmount === null || rule.maxAmount === undefined ? "" : String(Number(rule.maxAmount)));
    setEditRuleTolerance(String(Number(rule.amountTolerance || 0).toFixed(2)));
    setEditRulePriority(String(Number(rule.priority || 0)));
    setEditRuleActive(rule.isActive);
  };

  const saveRuleEdit = async () => {
    if (!activeBank?.id || !editingRuleId) return;
    if (!editRuleName.trim() || !editRuleText.trim()) {
      toast.error("Provide a rule name and match text.");
      return;
    }
    const minAmount = editRuleMin === "" ? null : Number(editRuleMin);
    const maxAmount = editRuleMax === "" ? null : Number(editRuleMax);
    const tolerance = editRuleTolerance === "" ? 0 : Number(editRuleTolerance);
    const priority = editRulePriority === "" ? 0 : Number(editRulePriority);
    if (editRuleMin !== "" && !Number.isFinite(minAmount as number)) {
      toast.error("Enter a valid minimum amount.");
      return;
    }
    if (editRuleMax !== "" && !Number.isFinite(maxAmount as number)) {
      toast.error("Enter a valid maximum amount.");
      return;
    }
    if (!Number.isFinite(tolerance)) {
      toast.error("Enter a valid tolerance.");
      return;
    }
    if (!Number.isFinite(priority)) {
      toast.error("Enter a valid priority.");
      return;
    }
    try {
      setEditRuleSaving(true);
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}/rules/${editingRuleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editRuleName.trim(),
          matchText: editRuleText.trim(),
          matchMode: editRuleMode,
          accountId: editRuleAccountId || null,
          minAmount,
          maxAmount,
          amountTolerance: tolerance,
          priority,
          isActive: editRuleActive,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to update rule.");
      toast.success("Rule updated.");
      setEditingRuleId("");
      queryClient.invalidateQueries({ queryKey: ["accounting", "bank-rules", activeBank.id] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update rule.");
    } finally {
      setEditRuleSaving(false);
    }
  };

  const deleteSingleTransaction = (txnId: string) => {
    setDeletingTxnId(txnId);
  };

  const confirmDeleteSingleTransaction = async () => {
    if (!activeBank?.id || !deletingTxnId) return;
    try {
      setBulkSaving(true);
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}/transactions/bulk`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [deletingTxnId], action: "DELETE" }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to delete transaction.");
      toast.success("Transaction deleted.");
      setDeletingTxnId("");
      queryClient.invalidateQueries({ queryKey: ["accounting", "bank-transactions", activeBank.id] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to delete transaction.");
    } finally {
      setBulkSaving(false);
    }
  };

  const confirmDeleteRule = async () => {
    const rule = pendingRuleDelete;
    if (!rule) return;
    if (!activeBank?.id) return;
    try {
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}/rules/${rule.id}`, {
        method: "DELETE",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to delete rule.");
      queryClient.invalidateQueries({ queryKey: ["accounting", "bank-rules", activeBank.id] });
      setPendingRuleDelete(null);
      toast.success("Rule deleted.");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to delete rule.");
    }
  };

  const updateActiveBank = async () => {
    if (!activeBank?.id) {
      toast.error("Select a bank account first.");
      return;
    }
    if (!bankProfileDirty) {
      toast.error("No bank profile changes to save.");
      return;
    }
    if (!editingBankName.trim()) {
      toast.error("Account name is required.");
      return;
    }
    try {
      setBankProfileSaving(true);
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editingBankName.trim(),
          bankName: editingBankLegalName.trim() || null,
          accountNumberMasked: editingAccountMasked.trim() || null,
          isActive: editingBankActive,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to update bank account.");
      queryClient.invalidateQueries({ queryKey: ["accounting", "banks"] });
      setBankProfileEditMode(false);
      setBankProfileSaveDialogOpen(false);
      toast.success("Bank account updated.");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update bank account.");
    } finally {
      setBankProfileSaving(false);
    }
  };

  const cancelBankProfileEdit = () => {
    if (!activeBank) return;
    setEditingBankName(activeBank.name || "");
    setEditingBankLegalName(activeBank.bankName || "");
    setEditingAccountMasked(activeBank.accountNumberMasked || "");
    setEditingBankActive(Boolean(activeBank.isActive));
    setBankProfileEditMode(false);
    setBankProfileSaveDialogOpen(false);
  };

  const importRules = async (file: File) => {
    if (!activeBank?.id) return;
    try {
      setImporting(true);
      const text = await file.text();
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}/rules/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to import rules.");
      toast.success(`Imported ${j.imported ?? 0} rule(s).`);
      queryClient.invalidateQueries({ queryKey: ["accounting", "bank-rules", activeBank.id] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to import rules.");
    } finally {
      setImporting(false);
    }
  };

  const downloadIssuesCsv = async (runId: string) => {
    if (!activeBank?.id) return;
    try {
      setDownloadingIssuesRunId(runId);
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}/import-runs/${runId}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to load run details.");
      const issuesList = Array.isArray(j?.issuesList) ? j.issuesList : [];
      const preview = Array.isArray(j?.issuesPreview) ? j.issuesPreview : [];
      const rows = (issuesList.length ? issuesList : preview).filter(
        (row: unknown) =>
          typeof row === "object" && row !== null && "row" in row && "reason" in row,
      ) as Array<{ row: number; reason: string }>;
      if (!rows.length) {
        toast.error("No issue rows are available for this import run.");
        return;
      }
      const header = ["row", "reason"];
      const csv = [header, ...rows.map((row) => [String(row.row), String(row.reason)])]
        .map((line) => line.map((cell) => escapeCsv(cell)).join(","))
        .join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `bank-import-run-issues-${runId}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      void logAdminExportDownload({
        area: "accounting-bank-import-run-issues",
        format: "CSV",
        fileName: `bank-import-run-issues-${runId}.csv`,
        sourcePage: "admin/accounting/banks",
        scopeSnapshot: `Bank: ${activeBank?.name || activeBank?.id || "unknown"} · Import run: ${runId}`,
        resultSummary: `Downloaded ${rows.length} bank import issue row(s).`,
        rowCount: rows.length,
        columnCount: header.length,
        byteSize: blob.size,
        matchingCount: rows.length,
        totalCount: rows.length,
      });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to download issues CSV.");
    } finally {
      setDownloadingIssuesRunId("");
    }
  };

  const loadRunDetails = async (runId: string) => {
    if (!activeBank?.id) return;
    if (runDetailsById[runId]) {
      setExpandedRunId((prev) => (prev === runId ? "" : runId));
      return;
    }
    try {
      setLoadingRunDetailsId(runId);
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}/import-runs/${runId}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to load import run details.");
      const details: BankImportRunDetails = {
        id: String(j.id || runId),
        at: String(j.at || ""),
        actor: String(j.actor || "Unknown"),
        created: Number(j.created || 0),
        updated: Number(j.updated || 0),
        skipped: Number(j.skipped || 0),
        issuesCount: Number(j.issuesCount || 0),
        issuesPreview: Array.isArray(j.issuesPreview) ? j.issuesPreview : [],
        issuesList: Array.isArray(j.issuesList) ? j.issuesList : [],
        outcomePreview: {
          created: Array.isArray(j?.outcomePreview?.created) ? j.outcomePreview.created : [],
          updated: Array.isArray(j?.outcomePreview?.updated) ? j.outcomePreview.updated : [],
          skipped: Array.isArray(j?.outcomePreview?.skipped) ? j.outcomePreview.skipped : [],
        },
      };
      setRunDetailsById((prev) => ({ ...prev, [runId]: details }));
      setExpandedRunId(runId);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to load import run details.");
    } finally {
      setLoadingRunDetailsId("");
    }
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Bank Accounts</h1>
        <p className="text-sm text-muted-foreground">
          Track bank accounts and reconcile transactions.
        </p>
        <div className="mt-3">
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <Link
                href={
                  activeBank?.id
                    ? `/admin/import-export?focusImport=bankTransactions&bankId=${encodeURIComponent(activeBank.id)}`
                    : "/admin/import-export?focusImport=bankTransactions"
                }
              >
                Bulk import transactions
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link
                href={
                  activeBank?.id
                    ? `/admin/accounting/banks/all-transactions?bankAccountId=${encodeURIComponent(activeBank.id)}`
                    : "/admin/accounting/banks/all-transactions"
                }
              >
                All banks transactions
              </Link>
            </Button>
            {activeBank?.id ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`/admin/accounting/reconciliations?bankAccountId=${encodeURIComponent(activeBank.id)}`}>
                  Open reconciliations
                </Link>
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled>
                Open reconciliations
              </Button>
            )}
            {isAdmin ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/audit?sourcePage=admin%2Faccounting%2Fbanks">Open bank audit</Link>
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {banksIsError ? (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {banksError instanceof Error ? banksError.message : "Failed to load bank accounts."}
        </div>
      ) : null}

      {accountsIsError ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {accountsError instanceof Error ? accountsError.message : "Failed to load ledger accounts."} Rule account
          linking is temporarily unavailable.
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Add bank account</CardTitle>
            <Button size="sm" variant="outline" onClick={() => setShowAddBankForm((v) => !v)}>
              {showAddBankForm ? "Cancel" : "+ Add bank account"}
            </Button>
          </div>
        </CardHeader>
        {showAddBankForm ? (
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Create a new bank account context before importing or entering transactions.
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">Account name</span>
                <Input value={accountName} onChange={(e) => setAccountName(e.target.value)} />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">Bank name</span>
                <Input value={bankName} onChange={(e) => setBankName(e.target.value)} />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">Masked account number</span>
                <Input value={accountMasked} onChange={(e) => setAccountMasked(e.target.value)} />
              </label>
            </div>
            <div>
              <Button className="w-full sm:w-auto" onClick={createBank} disabled={bankSaving}>
                {bankSaving ? "Saving..." : "Add bank"}
              </Button>
            </div>
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <div className="space-y-1">
            <CardTitle>Bank operations</CardTitle>
            <p className="text-sm text-muted-foreground">
              Choose the active bank context, review its current status, and move directly into the next accounting action.
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {banks.length > 0 ? (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
              <div className="rounded-xl border bg-slate-50/70 p-4">
                <div className="space-y-1.5">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Working bank account
                  </div>
                  <select
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm sm:max-w-md"
                    value={activeBank?.id || ""}
                    onChange={(e) => setSelectedBankId(e.target.value)}
                  >
                    <option value="">Select bank account...</option>
                    {banks.map((bank) => (
                      <option key={bank.id} value={bank.id}>
                        {bank.name} ({bank.currency})
                      </option>
                    ))}
                  </select>
                </div>

                {activeBank ? (
                  <div className="mt-3 rounded-lg border bg-background px-3 py-3 text-xs text-muted-foreground">
                    <div className="font-medium text-foreground">Current context</div>
                    <div className="mt-1">
                      Showing transactions for: <span className="font-medium">{activeBank.name}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span>{activeBank.bankName || "No bank name recorded yet"}</span>
                      <span className="text-slate-300">|</span>
                      <span>{activeBank.accountNumberMasked || "No masked account number"}</span>
                      <span className="text-slate-300">|</span>
                      <span>{activeBank.currency}</span>
                      <span
                        className={
                          activeBank.isActive
                            ? "rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-emerald-800"
                            : "rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-amber-800"
                        }
                      >
                        {activeBank.isActive ? "Active bank" : "Inactive bank"}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 rounded-lg border border-dashed border-amber-300 bg-amber-50/60 px-3 py-3 text-xs text-amber-800">
                    Choose a bank account before adding or reviewing transactions.
                  </div>
                )}
              </div>

              <div className="space-y-3 rounded-xl border bg-background p-4">
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">At a glance</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Keep bank status, imports, rules, and reconciliation handoff visible without leaving this view.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border bg-slate-50 px-3 py-3">
                    <div className="text-xs font-medium text-muted-foreground">Transactions</div>
                    <div className="text-2xl font-semibold tabular-nums">
                      {activeBank ? transactionSummary.total : 0}
                    </div>
                  </div>
                  <div className="rounded-lg border bg-amber-50 px-3 py-3">
                    <div className="text-xs font-medium text-muted-foreground">Unmatched</div>
                    <div className="text-2xl font-semibold tabular-nums">
                      {activeBank ? transactionSummary.unmatched : 0}
                    </div>
                  </div>
                  <div className="rounded-lg border bg-slate-50 px-3 py-3">
                    <div className="text-xs font-medium text-muted-foreground">Active rules</div>
                    <div className="text-2xl font-semibold tabular-nums">
                      {activeBank ? rules.filter((rule) => rule.isActive).length : 0}
                    </div>
                  </div>
                  <div className="rounded-lg border bg-slate-50 px-3 py-3">
                    <div className="text-xs font-medium text-muted-foreground">Recent import runs</div>
                    <div className="text-2xl font-semibold tabular-nums">{activeBank ? importRuns.length : 0}</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link
                      href={
                        activeBank?.id
                          ? `/admin/import-export?focusImport=bankTransactions&bankId=${encodeURIComponent(activeBank.id)}`
                          : "/admin/import-export?focusImport=bankTransactions"
                      }
                    >
                      Bulk import
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link
                      href={
                        activeBank?.id
                          ? `/admin/accounting/banks/all-transactions?bankAccountId=${encodeURIComponent(activeBank.id)}`
                          : "/admin/accounting/banks/all-transactions"
                      }
                    >
                      Global view
                    </Link>
                  </Button>
                  {activeBank?.id ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/admin/accounting/reconciliations?bankAccountId=${encodeURIComponent(activeBank.id)}`}>
                        Reconciliations
                      </Link>
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled>
                      Reconciliations
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Add a bank account to begin.</p>
          )}

          {activeBank ? (
            <div className="space-y-2 rounded-md border p-3">
              <div className="text-xs font-medium text-muted-foreground">Selected bank profile</div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Account name</span>
                  <Input
                    value={editingBankName}
                    onChange={(e) => setEditingBankName(e.target.value)}
                    disabled={!bankProfileEditMode || bankProfileSaving}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Bank name</span>
                  <Input
                    value={editingBankLegalName}
                    onChange={(e) => setEditingBankLegalName(e.target.value)}
                    disabled={!bankProfileEditMode || bankProfileSaving}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Masked account number</span>
                  <Input
                    value={editingAccountMasked}
                    onChange={(e) => setEditingAccountMasked(e.target.value)}
                    disabled={!bankProfileEditMode || bankProfileSaving}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Status</span>
                  <select
                    className="h-10 rounded-md border bg-background px-3 text-sm"
                    value={editingBankActive ? "active" : "inactive"}
                    onChange={(e) => setEditingBankActive(e.target.value === "active")}
                    disabled={!bankProfileEditMode || bankProfileSaving}
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </label>
              </div>
              {bankProfileEditMode ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setBankProfileSaveDialogOpen(true)}
                    disabled={!bankProfileDirty || bankProfileSaving}
                  >
                    {bankProfileSaving ? "Saving..." : "Save bank profile"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={cancelBankProfileEdit} disabled={bankProfileSaving}>
                    Cancel
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {bankProfileDirty ? "Unsaved changes." : "No changes yet."}
                  </span>
                </div>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setBankProfileEditMode(true)}>
                  Edit bank profile
                </Button>
              )}
            </div>
          ) : null}

          {activeBank ? (
            <div className="space-y-3 rounded-md border p-3">
              <div>
                <div className="text-xs font-medium text-muted-foreground">Manual transaction entry</div>
                <p className="text-xs text-muted-foreground">
                  Use this for controlled fixes or one-off transactions. Imports remain the primary workflow.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Posting date</span>
                  <Input type="date" value={postedAt} onChange={(e) => setPostedAt(e.target.value)} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Amount</span>
                  <Input
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Type</span>
                  <select
                    className="h-10 rounded-md border bg-background px-3 text-sm"
                    value={type}
                    onChange={(e) => setType(e.target.value as "DEBIT" | "CREDIT")}
                  >
                    <option value="CREDIT">Credit (in)</option>
                    <option value="DEBIT">Debit (out)</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Description</span>
                  <Input value={description} onChange={(e) => setDescription(e.target.value)} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Reference</span>
                  <Input value={reference} onChange={(e) => setReference(e.target.value)} />
                </label>
              </div>
              <div className="sm:col-span-2 lg:col-span-3 flex flex-wrap items-center gap-2">
                <Button
                  className="w-full sm:w-auto"
                  onClick={() => void addTransaction()}
                  disabled={bankSaving}
                >
                  {bankSaving ? "Saving..." : "Add transaction"}
                </Button>
              </div>
            </div>
          ) : null}

          {duplicateConflict ? (
            <div className="space-y-2 rounded-md border border-amber-400/50 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <div>{duplicateConflict.message}</div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => openDuplicateExisting(duplicateConflict.id)}>
                  Open existing transaction
                </Button>
                <Input
                  className="w-full sm:max-w-sm"
                  placeholder="Reason for duplicate override (required)"
                  value={duplicateReason}
                  onChange={(e) => setDuplicateReason(e.target.value)}
                />
                <Button size="sm" variant="outline" onClick={() => void addTransaction({ allowDuplicate: true })}>
                  Force create with reason
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDuplicateConflict(null)}>
                  Dismiss
                </Button>
              </div>
            </div>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-10">
            <label className="space-y-1 xl:col-span-4">
              <span className="text-xs font-medium text-muted-foreground">Search</span>
              <Input
                placeholder="Description, reference, amount, type..."
                value={transactionSearch}
                onChange={(e) => setTransactionSearch(e.target.value)}
              />
            </label>
            <label className="space-y-1 xl:col-span-2">
              <span className="text-xs font-medium text-muted-foreground">From date</span>
              <Input type="date" value={txnFromDate} onChange={(e) => setTxnFromDate(e.target.value)} />
            </label>
            <label className="space-y-1 xl:col-span-2">
              <span className="text-xs font-medium text-muted-foreground">To date</span>
              <Input type="date" value={txnToDate} onChange={(e) => setTxnToDate(e.target.value)} />
            </label>
            <label className="space-y-1 xl:col-span-2">
              <span className="text-xs font-medium text-muted-foreground">Sort by</span>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={txnSortBy}
                onChange={(e) => setTxnSortBy(e.target.value as TransactionSortBy)}
              >
                <option value="postedAt">Posted date</option>
                <option value="amount">Amount</option>
                <option value="type">Type</option>
                <option value="description">Description</option>
                <option value="reference">Reference</option>
                <option value="matched">Match status</option>
              </select>
            </label>
            <label className="space-y-1 xl:col-span-2">
              <span className="text-xs font-medium text-muted-foreground">Direction</span>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={txnSortDir}
                onChange={(e) => setTxnSortDir(e.target.value as TransactionSortDir)}
              >
                <option value="desc">Newest / highest first</option>
                <option value="asc">Oldest / lowest first</option>
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={unmatchedOnly ? "default" : "outline"}
              onClick={() => setUnmatchedOnly((prev) => !prev)}
              title="Show only transactions that are not matched to reconciliation lines."
            >
              {`Unmatched only: ${unmatchedOnly ? "On" : "Off"}`}
            </Button>
            {(txnFromDate || txnToDate) ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setTxnFromDate("");
                  setTxnToDate("");
                }}
              >
                Clear dates
              </Button>
            ) : null}
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Rows per page</span>
              <select
                className="h-9 rounded-md border bg-background px-2 text-xs"
                value={String(pageSize)}
                onChange={(e) => setPageSize(Number(e.target.value))}
              >
                <option value="10">10</option>
                <option value="20">20</option>
                <option value="50">50</option>
                <option value="100">100</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Saved view</span>
              <select
                className="h-9 min-w-48 rounded-md border bg-background px-2 text-xs"
                value={selectedSavedFilterId}
                onChange={(e) => applySavedFilter(e.target.value)}
              >
                <option value="">Saved filters</option>
                {savedFilters.map((filter) => (
                  <option key={filter.id} value={filter.id}>
                    {filter.name}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" variant="outline" onClick={saveCurrentFilter}>
              Save filter
            </Button>
            <Button size="sm" variant="ghost" onClick={deleteSavedFilter}>
              Delete filter
            </Button>
            <span className="text-xs text-muted-foreground">
              {selectedTxnIds.length} selected / {transactionSummary.total} matching current filters
            </span>
          </div>

          <div className="sticky top-2 z-20 rounded-md border bg-background/95 p-2 backdrop-blur">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!selectedTxnIds.length || bulkSaving}
                onClick={exportSelectedTransactionsCsv}
                title="Download CSV for currently selected rows only."
              >
                Export selected CSV
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={transactionSummary.total === 0 || bulkSaving || exportingCsvScope !== ""}
                onClick={() => void exportServerTransactionsCsv("filtered")}
                title="Download CSV for rows matching current search and filter settings."
              >
                {exportingCsvScope === "filtered" ? "Preparing filtered CSV..." : "Export filtered CSV"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={transactionSummary.total === 0 || bulkSaving || exportingCsvScope !== ""}
                onClick={() => void exportServerTransactionsCsv("all")}
                title="Download CSV for all rows in this bank account."
              >
                {exportingCsvScope === "all" ? "Preparing full CSV..." : "Export all CSV"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!selectedTxnIds.length || bulkSaving}
                onClick={() => runTxnBulkAction("SET_TYPE", "DEBIT")}
                title="Bulk update selected rows to DEBIT (cash outflow)."
              >
                Set type: DEBIT
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!selectedTxnIds.length || bulkSaving}
                onClick={() => runTxnBulkAction("SET_TYPE", "CREDIT")}
                title="Bulk update selected rows to CREDIT (cash inflow)."
              >
                Set type: CREDIT
              </Button>
              {isAdmin ? (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={!selectedTxnIds.length || bulkSaving}
                  onClick={() => runTxnBulkAction("DELETE")}
                  title="Delete selected rows (matched rows cannot be deleted)."
                >
                  Delete selected
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">Delete actions require ADMIN role.</span>
              )}
            </div>
          </div>

          {txnsIsError ? (
            <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
              {txnsError instanceof Error ? txnsError.message : "Failed to load transactions."}
            </div>
          ) : null}

          <div className="space-y-1 text-sm">
            {txnsLoading ? (
              <p className="text-muted-foreground">Loading transactions…</p>
            ) : txnsIsError ? (
              null
            ) : transactions.length === 0 ? (
              <p className="text-muted-foreground">
                {transactionSummary.total === 0 ? "No transactions yet." : "No transactions match the current page."}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full min-w-[980px] text-sm">
                  <thead className="bg-slate-50 text-left text-xs font-medium text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">
                        <input
                          aria-label="Select all transactions on this page"
                          type="checkbox"
                          checked={
                            visibleTxnIds.length > 0 && visibleTxnIds.every((id) => selectedTxnIds.includes(id))
                          }
                          onChange={(e) => toggleAllVisibleTxns(e.target.checked)}
                        />
                      </th>
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Description</th>
                      <th className="px-3 py-2">Reference</th>
                      <th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((txn) =>
                      editingTxnId === txn.id ? (
                        <tr key={txn.id} className="border-t">
                          <td colSpan={8} className="px-3 py-3">
                            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                              <Input
                                aria-label="Edit posting date"
                                type="date"
                                value={editPostedAt}
                                onChange={(e) => setEditPostedAt(e.target.value)}
                              />
                              <Input
                                aria-label="Edit amount"
                                value={editAmount}
                                onChange={(e) => setEditAmount(e.target.value)}
                              />
                              <select
                                aria-label="Edit transaction type"
                                className="h-10 rounded-md border bg-background px-3 text-sm"
                                value={editType}
                                onChange={(e) => setEditType(e.target.value as "DEBIT" | "CREDIT")}
                              >
                                <option value="CREDIT">Credit (in)</option>
                                <option value="DEBIT">Debit (out)</option>
                              </select>
                              <Input
                                aria-label="Edit description"
                                value={editDescription}
                                onChange={(e) => setEditDescription(e.target.value)}
                              />
                              <Input
                                aria-label="Edit reference"
                                value={editReference}
                                onChange={(e) => setEditReference(e.target.value)}
                              />
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Button size="sm" onClick={() => void saveEditTransaction()} disabled={editingSave}>
                                {editingSave ? "Saving..." : "Save"}
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setEditingTxnId("")}>
                                Cancel
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        <tr
                          key={txn.id}
                          className={`border-t align-top ${highlightTxnId === txn.id ? "bg-amber-50" : ""}`}
                        >
                          <td className="px-3 py-3">
                            <input
                              aria-label={`Select transaction ${txn.id}`}
                              type="checkbox"
                              checked={selectedTxnIds.includes(txn.id)}
                              onChange={(e) => toggleTxnSelection(txn.id, e.target.checked)}
                            />
                          </td>
                          <td className="px-3 py-3 font-medium tabular-nums">{formatBankDate(txn.postedAt)}</td>
                          <td className="px-3 py-3 text-muted-foreground">{txn.description || "—"}</td>
                          <td className="px-3 py-3 text-muted-foreground">{txn.reference || "—"}</td>
                          <td className="px-3 py-3">
                            <span
                              className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                                txn.type === "CREDIT" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
                              }`}
                            >
                              {txn.type === "CREDIT" ? "CR" : "DR"}
                            </span>
                          </td>
                          <td
                            className={`px-3 py-3 text-right font-medium tabular-nums ${
                              txn.type === "CREDIT" ? "text-green-700" : "text-red-700"
                            }`}
                          >
                            {txn.type === "CREDIT" ? "+" : "-"}
                            {activeBank?.currency || "GHS"} {Number(txn.amount).toFixed(2)}
                          </td>
                          <td className="px-3 py-3">
                            {txn.matched ? (
                              <span className="rounded border border-green-300 bg-green-50 px-1.5 py-0.5 text-xs text-green-800">
                                matched
                              </span>
                            ) : (
                              <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-xs text-slate-500">
                                unmatched
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={txn.matched}
                                onClick={() => startEditTransaction(txn)}
                              >
                                Edit
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setSelectedTxnForRuleTestId(txn.id)}
                              >
                                Test rules
                              </Button>
                              {isAdmin ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={txn.matched || bulkSaving}
                                  className="text-destructive hover:text-destructive"
                                  title={txn.matched ? "Unmatch before deleting." : "Delete this transaction."}
                                  onClick={() => deleteSingleTransaction(txn.id)}
                                >
                                  Delete
                                </Button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Page {page} of {totalPages} · {transactionSummary.total} matching transaction(s)
            </span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>

          {selectedTxnForRuleTest ? (
            <div className="space-y-2 rounded-md border p-3 text-xs">
              <div className="flex items-center justify-between">
                <div className="font-medium">Rule test drawer</div>
                <Button size="sm" variant="ghost" onClick={() => setSelectedTxnForRuleTestId("")}>
                  Close
                </Button>
              </div>
              <div className="text-muted-foreground">
                Testing transaction: {formatBankDate(selectedTxnForRuleTest.postedAt)} |{" "}
                {Number(selectedTxnForRuleTest.amount).toFixed(2)} | {selectedTxnForRuleTest.description || "-"} |{" "}
                {selectedTxnForRuleTest.reference || "-"}
              </div>
              <div className="space-y-1">
                {rules.length === 0 ? (
                  <p className="text-muted-foreground">No rules available.</p>
                ) : (
                  rules.map((rule) => {
                    const result = evaluateRule(selectedTxnForRuleTest, rule);
                    return (
                      <div key={rule.id} className="rounded border p-2">
                        <div className="flex items-center justify-between">
                          <span>
                            {rule.name} ({rule.matchMode})
                          </span>
                          <span className={result.matched ? "text-green-700" : "text-red-700"}>
                            {result.matched ? "MATCH" : "MISS"}
                          </span>
                        </div>
                        <div className="mt-1 text-muted-foreground">{result.checks.join(" ")}</div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Matching rules</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!activeBank ? (
            <p className="text-sm text-muted-foreground">Select a bank account to configure rules.</p>
          ) : (
            <>
              {rulesIsError ? (
                <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
                  {rulesError instanceof Error ? rulesError.message : "Failed to load rules."}
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Rule name</span>
                  <Input value={ruleName} onChange={(e) => setRuleName(e.target.value)} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Match text</span>
                  <Input value={ruleText} onChange={(e) => setRuleText(e.target.value)} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Match mode</span>
                  <select
                    className="h-10 rounded-md border bg-background px-3 text-sm"
                    value={ruleMode}
                    onChange={(e) => setRuleMode(e.target.value as BankMatchRule["matchMode"])}
                  >
                    <option value="CONTAINS">Contains</option>
                    <option value="STARTS_WITH">Starts with</option>
                    <option value="ENDS_WITH">Ends with</option>
                    <option value="REGEX">Regex</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Ledger account</span>
                  <select
                    className="h-10 rounded-md border bg-background px-3 text-sm"
                    value={ruleAccountId}
                    onChange={(e) => setRuleAccountId(e.target.value)}
                    disabled={accountsIsError}
                  >
                    <option value="">Any account</option>
                    {(accountsData || []).map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.code} - {acc.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Min amount</span>
                  <Input inputMode="decimal" value={ruleMin} onChange={(e) => setRuleMin(e.target.value)} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Max amount</span>
                  <Input inputMode="decimal" value={ruleMax} onChange={(e) => setRuleMax(e.target.value)} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Tolerance ({activeBank.currency})</span>
                  <Input inputMode="decimal" value={ruleTolerance} onChange={(e) => setRuleTolerance(e.target.value)} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Priority</span>
                  <Input inputMode="numeric" value={rulePriority} onChange={(e) => setRulePriority(e.target.value)} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Status</span>
                  <select
                    className="h-10 rounded-md border bg-background px-3 text-sm"
                    value={ruleActive ? "active" : "inactive"}
                    onChange={(e) => setRuleActive(e.target.value === "active")}
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </label>
                <div className="sm:col-span-2 lg:col-span-3 flex flex-wrap gap-2">
                  <Button className="w-full sm:w-auto" onClick={createRule} disabled={ruleSaving}>
                    {ruleSaving ? "Saving..." : "Add rule"}
                  </Button>
                  <Button asChild variant="outline" size="sm" className="w-full sm:w-auto">
                    <a href={`/api/admin/accounting/banks/${activeBank.id}/rules/export?sourcePage=admin%2Faccounting%2Fbanks`}>
                      Export CSV
                    </a>
                  </Button>
                  <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded border px-2 py-1">Import CSV</span>
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      disabled={importing}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void importRules(file);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {importing ? <span className="text-xs text-muted-foreground">Importing...</span> : null}
                </div>
              </div>

              <div className="space-y-2 rounded-md border p-3 text-xs">
                <div className="font-medium">Rule simulator (current transaction sample)</div>
                <div className="text-muted-foreground">
                  Sample size: {simulator.sampleCount} transaction(s) from the current page of filtered results.
                </div>
                {simulator.activeRules.length === 0 ? (
                  <div className="text-muted-foreground">Add at least one active rule to see simulation metrics.</div>
                ) : simulator.sampleCount === 0 ? (
                  <div className="text-muted-foreground">No transactions in the current sample.</div>
                ) : (
                  <>
                    <div>
                      Potential false-positive signal: {simulator.overlapCount} row(s) matched by multiple active
                      rules.
                    </div>
                    <div className="space-y-1">
                      {simulator.byRule.map((item) => (
                        <div key={item.rule.id} className="flex items-center justify-between gap-2 border-b py-1">
                          <span>
                            {item.rule.name} ({item.rule.matchMode})
                          </span>
                          <span>
                            {item.matchedCount} rows ({(item.matchRate * 100).toFixed(1)}%)
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="text-muted-foreground">
                      Affected account preview:{" "}
                      {simulator.accountPreview.length
                        ? simulator.accountPreview
                            .slice(0, 6)
                            .map((row) => `${row.account} (${row.matchedCount})`)
                            .join(", ")
                        : "No account-linked matches in sample."}
                    </div>
                  </>
                )}
              </div>

              <div className="space-y-2 rounded-md border p-3 text-xs">
                <div className="font-medium">Rule conflict inspector</div>
                {conflictInspector.length === 0 ? (
                  <p className="text-muted-foreground">No active rule overlap pairs detected in current sample.</p>
                ) : (
                  conflictInspector.map((item) => (
                    <div key={item.key} className="flex items-center justify-between border-b py-1">
                      <span>
                        {item.left.name} <span className="text-muted-foreground">vs</span> {item.right.name}
                      </span>
                      <span>{item.count} overlapping row(s)</span>
                    </div>
                  ))
                )}
              </div>

              <div className="text-sm space-y-2">
                <div className="text-xs font-medium text-muted-foreground">
                  Current Rule Set for {activeBank?.name || "Selected Bank"}
                </div>
                {rulesLoading ? (
                  <p className="text-muted-foreground">Loading rules…</p>
                ) : rules.length === 0 ? (
                  <p className="text-muted-foreground">No rules yet.</p>
                ) : (
                  rules.map((rule) =>
                    editingRuleId === rule.id ? (
                      <div key={rule.id} className="space-y-2 rounded-md border border-blue-200 bg-blue-50/40 p-3">
                        <div className="text-xs font-medium text-muted-foreground">Editing rule</div>
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          <Input placeholder="Rule name" value={editRuleName} onChange={(e) => setEditRuleName(e.target.value)} />
                          <Input placeholder="Match text" value={editRuleText} onChange={(e) => setEditRuleText(e.target.value)} />
                          <select
                            className="h-10 rounded-md border bg-background px-3 text-sm"
                            value={editRuleMode}
                            onChange={(e) => setEditRuleMode(e.target.value as BankMatchRule["matchMode"])}
                          >
                            <option value="CONTAINS">Contains</option>
                            <option value="STARTS_WITH">Starts with</option>
                            <option value="ENDS_WITH">Ends with</option>
                            <option value="REGEX">Regex</option>
                          </select>
                          <select
                            className="h-10 rounded-md border bg-background px-3 text-sm"
                            value={editRuleAccountId}
                            onChange={(e) => setEditRuleAccountId(e.target.value)}
                          >
                            <option value="">Any account</option>
                            {(accountsData || []).map((acc) => (
                              <option key={acc.id} value={acc.id}>{acc.code} - {acc.name}</option>
                            ))}
                          </select>
                          <Input placeholder="Min amount (optional)" inputMode="decimal" value={editRuleMin} onChange={(e) => setEditRuleMin(e.target.value)} />
                          <Input placeholder="Max amount (optional)" inputMode="decimal" value={editRuleMax} onChange={(e) => setEditRuleMax(e.target.value)} />
                          <Input placeholder="Tolerance (GHS)" inputMode="decimal" value={editRuleTolerance} onChange={(e) => setEditRuleTolerance(e.target.value)} />
                          <Input placeholder="Priority" inputMode="numeric" value={editRulePriority} onChange={(e) => setEditRulePriority(e.target.value)} />
                          <select
                            className="h-10 rounded-md border bg-background px-3 text-sm"
                            value={editRuleActive ? "active" : "inactive"}
                            onChange={(e) => setEditRuleActive(e.target.value === "active")}
                          >
                            <option value="active">Active</option>
                            <option value="inactive">Inactive</option>
                          </select>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" onClick={() => void saveRuleEdit()} disabled={editRuleSaving}>
                            {editRuleSaving ? "Saving..." : "Save changes"}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingRuleId("")} disabled={editRuleSaving}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div key={rule.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-2">
                        <div>
                          <div className="font-medium">
                            {rule.name}{" "}
                            {rule.isActive ? null : (
                              <span className="ml-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-xs text-slate-500">inactive</span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {rule.matchMode} &quot;{rule.matchText}&quot; · {rule.account?.name || "Any account"} ·
                            priority {Number(rule.priority || 0)}
                            {rule.minAmount ? ` · min ${Number(rule.minAmount).toFixed(2)}` : ""}
                            {rule.maxAmount ? ` · max ${Number(rule.maxAmount).toFixed(2)}` : ""}
                            {Number(rule.amountTolerance || 0) > 0 ? ` · tol ±${Number(rule.amountTolerance).toFixed(2)}` : ""}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="outline" onClick={() => bumpRulePriority(rule, 1)}>
                            Up
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => bumpRulePriority(rule, -1)}>
                            Down
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => startEditRule(rule)}>
                            Edit
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => toggleRule(rule)}>
                            {rule.isActive ? "Disable" : "Enable"}
                          </Button>
                          {isAdmin ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              onClick={() => deleteRule(rule)}
                            >
                              Delete
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    )
                  )
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bank import runs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {!activeBank ? (
            <p className="text-muted-foreground">Select a bank account to view import run history.</p>
          ) : importRunsIsError ? (
            <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
              {importRunsError instanceof Error ? importRunsError.message : "Failed to load import runs."}
            </div>
          ) : importRuns.length === 0 ? (
            <p className="text-muted-foreground">No recent bank import runs for this account.</p>
          ) : (
            importRuns.map((run) => {
              const details = runDetailsById[run.id];
              const createdRows = details?.outcomePreview?.created || [];
              const updatedRows = details?.outcomePreview?.updated || [];
              const skippedRows = details?.outcomePreview?.skipped || [];
              return (
                <div key={run.id} className="space-y-2 rounded-md border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium">
                      {new Date(run.at).toLocaleString()} - {run.actor}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Created {run.created} | Updated {run.updated} | Skipped {run.skipped} | Issues {run.issuesCount}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {run.issuesCount > 0 ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={downloadingIssuesRunId === run.id}
                        onClick={() => void downloadIssuesCsv(run.id)}
                      >
                        {downloadingIssuesRunId === run.id ? "Preparing..." : "Download issues CSV"}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={loadingRunDetailsId === run.id}
                      onClick={() => void loadRunDetails(run.id)}
                    >
                      {loadingRunDetailsId === run.id
                        ? "Loading..."
                        : expandedRunId === run.id
                          ? "Hide diff preview"
                          : "View diff preview"}
                    </Button>
                    <Button asChild size="sm" variant="ghost">
                      <Link href={`/admin/import-export?focusImport=bankTransactions&bankId=${encodeURIComponent(activeBank.id)}`}>
                        Import transactions
                      </Link>
                    </Button>
                  </div>
                  {expandedRunId === run.id && details ? (
                    <div className="space-y-2 rounded-md border p-2 text-xs">
                      <div className="font-medium">Import diff preview (row-level)</div>
                      <div>
                        <div className="font-medium">Created rows ({createdRows.length})</div>
                        {createdRows.length === 0 ? (
                          <div className="text-muted-foreground">No created row previews captured.</div>
                        ) : (
                          createdRows.slice(0, 20).map((row) => (
                            <div key={`c-${row.row}`} className="border-b py-1">
                              Row {row.row}: {row.bankName || "-"} | {row.date || "-"} | {row.amount || "-"} |{" "}
                              {row.reference || "-"}
                            </div>
                          ))
                        )}
                      </div>
                      <div>
                        <div className="font-medium">Updated rows ({updatedRows.length})</div>
                        {updatedRows.length === 0 ? (
                          <div className="text-muted-foreground">No updated row previews captured.</div>
                        ) : (
                          updatedRows.slice(0, 20).map((row) => (
                            <div key={`u-${row.row}`} className="border-b py-1">
                              Row {row.row}: {row.bankName || "-"} | {row.date || "-"} | {row.amount || "-"} |{" "}
                              {row.reference || "-"}
                            </div>
                          ))
                        )}
                      </div>
                      <div>
                        <div className="font-medium">Skipped rows ({skippedRows.length})</div>
                        {skippedRows.length === 0 ? (
                          <div className="text-muted-foreground">No skipped row previews captured.</div>
                        ) : (
                          skippedRows.slice(0, 20).map((row) => (
                            <div key={`s-${row.row}`} className="border-b py-1">
                              Row {row.row}: {row.reason || "Skipped"}
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
      <Dialog open={saveFilterDialogOpen} onOpenChange={setSaveFilterDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save filter</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="Filter name"
            value={saveFilterName}
            onChange={(e) => setSaveFilterName(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveFilterDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmSaveCurrentFilter} disabled={!saveFilterName.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={bulkDeleteDialogOpen} onOpenChange={setBulkDeleteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete selected transactions?</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              {selectedTxnIds.length} transaction(s) selected.
            </p>
            {(() => {
              const matchedInSelection = selectedTxns.filter((t) => t.matched).length;
              return matchedInSelection > 0 ? (
                <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800">
                  {matchedInSelection} of these transaction(s) are matched and cannot be deleted. The entire operation will fail — unmatch them first.
                </p>
              ) : null;
            })()}
            <p>This action is permanent and cannot be undone.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                setBulkDeleteDialogOpen(false);
                await runTxnBulkAction("DELETE", undefined, { confirmedDelete: true });
              }}
              disabled={!selectedTxnIds.length || bulkSaving}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deletingTxnId)} onOpenChange={(open) => !open && setDeletingTxnId("")}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete transaction?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently delete the transaction. This action cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingTxnId("")} disabled={bulkSaving}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDeleteSingleTransaction()} disabled={bulkSaving}>
              {bulkSaving ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(pendingRuleDelete)} onOpenChange={(open) => !open && setPendingRuleDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete rule?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {pendingRuleDelete ? `Rule "${pendingRuleDelete.name}" will be removed.` : "This rule will be removed."}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingRuleDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDeleteRule()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={bankProfileSaveDialogOpen} onOpenChange={setBankProfileSaveDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save bank profile changes?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will update account name, bank name, masked number, and active status for the selected bank.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBankProfileSaveDialogOpen(false)} disabled={bankProfileSaving}>
              Cancel
            </Button>
            <Button onClick={() => void updateActiveBank()} disabled={!bankProfileDirty || bankProfileSaving}>
              {bankProfileSaving ? "Saving..." : "Confirm save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={editOverrideDialogOpen} onOpenChange={setEditOverrideDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Admin override required</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {editOverrideHint || "This transaction is outside the edit window. Provide a reason to proceed."}
          </p>
          <Input
            placeholder="Reason for override (required)"
            value={editOverrideReason}
            onChange={(e) => setEditOverrideReason(e.target.value)}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditOverrideDialogOpen(false);
                setEditOverrideReason("");
              }}
              disabled={editingSave}
            >
              Cancel
            </Button>
            <Button
              onClick={async () => {
                await saveEditTransaction({ overrideEditLock: true });
              }}
              disabled={editingSave || editOverrideReason.trim().length < 8}
            >
              {editingSave ? "Saving..." : "Confirm override"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
