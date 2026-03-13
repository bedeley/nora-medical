"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";

type BankTransaction = {
  id: string;
  postedAt: string;
  amount: number | string;
  description?: string | null;
  reference?: string | null;
  type: "DEBIT" | "CREDIT";
  matched: boolean;
};

type BankMatchRule = {
  id: string;
  name: string;
  matchText: string;
  matchMode: "CONTAINS" | "STARTS_WITH" | "ENDS_WITH" | "REGEX";
  accountId?: string | null;
  minAmount?: number | string | null;
  maxAmount?: number | string | null;
  amountTolerance?: number | string | null;
  isActive: boolean;
};

type JournalLine = {
  id: string;
  accountId?: string;
  debit: number | string;
  credit: number | string;
  description?: string | null;
  entry: {
    id: string;
    entryDate: string;
    status: string;
    memo?: string | null;
  };
  account: {
    code: string;
    name: string;
  };
};

type JournalEntryLine = Omit<JournalLine, "entry">;

type JournalEntry = {
  id: string;
  entryDate: string;
  status: string;
  memo?: string | null;
  lines: JournalEntryLine[];
};

type ReconciliationDetail = {
  id: string;
  bankAccountId: string;
  bankAccount: { id: string; name: string; currency: string };
  periodStart: string;
  periodEnd: string;
  status: "DRAFT" | "IN_PROGRESS" | "CLOSED";
  lines?: { journalLineId?: string | null }[];
};

type ReconciliationChecklist = {
  unmatchedBankTxns: number;
  unmatchedJournalLines: number;
};

type AutoMatchMode = "exact" | "tolerance" | "rules";
type AutoMatchSkip = {
  txnId: string;
  reason: string;
};
type AutoMatchResult = {
  mode: AutoMatchMode;
  matchedCount: number;
  attemptedCount: number;
  matchedTxnIds: string[];
  skipped: AutoMatchSkip[];
  at: string;
};
type WorkspaceEvent = {
  id: string;
  text: string;
  at: string;
  action?: string;
  actor?: string;
};

type AuthSession = {
  user?: {
    id?: string;
    role?: "ADMIN" | "ACCOUNTANT" | "STAFF" | "CUSTOMER" | "DISPATCHER";
  };
};

export default function ReconciliationMatchPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const params = useParams();
  const reconciliationId = String((params as { id?: string }).id || "");

  const { data: reconciliation } = useClientQuery<ReconciliationDetail>({
    queryKey: ["accounting", "reconciliation", reconciliationId],
    queryFn: () =>
      fetch(`/api/admin/accounting/reconciliations/${reconciliationId}`).then((r) => r.json()),
    enabled: Boolean(reconciliationId),
  });
  const { data: authSession } = useClientQuery<AuthSession>({
    queryKey: ["auth", "session"],
    queryFn: () => fetch("/api/auth/session").then((r) => r.json()),
  });
  const { data: persistedActivity } = useClientQuery<WorkspaceEvent[]>({
    queryKey: ["accounting", "reconciliation", reconciliationId, "activity"],
    queryFn: () =>
      fetch(`/api/admin/accounting/reconciliations/${reconciliationId}/activity`).then((r) => r.json()),
    enabled: Boolean(reconciliationId),
  });

  const bankAccountId = reconciliation?.bankAccountId;
  const { data: bankTxns } = useClientQuery<BankTransaction[]>({
    queryKey: ["accounting", "bank-transactions", bankAccountId],
    queryFn: () =>
      fetch(`/api/admin/accounting/banks/${bankAccountId}/transactions`).then((r) => r.json()),
    enabled: Boolean(bankAccountId),
  });

  const { data: journalEntries } = useClientQuery<JournalEntry[]>({
    queryKey: ["accounting", "journal"],
    queryFn: () => fetch("/api/admin/accounting/journal").then((r) => r.json()),
  });

  const { data: matchRules } = useClientQuery<BankMatchRule[]>({
    queryKey: ["accounting", "bank-rules", bankAccountId],
    queryFn: () => fetch(`/api/admin/accounting/banks/${bankAccountId}/rules`).then((r) => r.json()),
    enabled: Boolean(bankAccountId),
  });

  const journalLines = useMemo(() => {
    const entries = Array.isArray(journalEntries) ? journalEntries : [];
    return entries.flatMap((entry) =>
      (entry.lines || []).map((line) => ({
        ...line,
        entry: {
          id: entry.id,
          entryDate: entry.entryDate,
          status: entry.status,
          memo: entry.memo ?? null,
        },
      })),
    );
  }, [journalEntries]);
  const bankJournalLines = useMemo(() => {
    const bankName = reconciliation?.bankAccount?.name?.toLowerCase() || "";
    return journalLines.filter((line) => {
      if (line.entry.status !== "POSTED") return false;
      const code = line.account?.code || "";
      const name = line.account?.name?.toLowerCase() || "";
      if (code === "1010") return true;
      if (bankName && name.includes(bankName)) return true;
      return name.includes("bank");
    });
  }, [journalLines, reconciliation?.bankAccount?.name]);
  const periodStartAt = useMemo(
    () => (reconciliation?.periodStart ? new Date(reconciliation.periodStart) : null),
    [reconciliation?.periodStart],
  );
  const periodEndAt = useMemo(
    () => (reconciliation?.periodEnd ? new Date(reconciliation.periodEnd) : null),
    [reconciliation?.periodEnd],
  );
  const scopedBankTxns = useMemo(() => {
    if (!periodStartAt || !periodEndAt) return bankTxns || [];
    return (bankTxns || []).filter((txn) => {
      const postedAt = new Date(txn.postedAt);
      return postedAt >= periodStartAt && postedAt <= periodEndAt;
    });
  }, [bankTxns, periodStartAt, periodEndAt]);
  const periodJournalLines = useMemo(() => {
    if (!periodStartAt || !periodEndAt) return bankJournalLines;
    return bankJournalLines.filter((line) => {
      const entryDate = new Date(line.entry.entryDate);
      return entryDate >= periodStartAt && entryDate <= periodEndAt;
    });
  }, [bankJournalLines, periodStartAt, periodEndAt]);
  const matchedJournalLineIds = useMemo(
    () =>
      new Set(
        (reconciliation?.lines || [])
          .map((line) => line.journalLineId)
          .filter((id): id is string => Boolean(id)),
      ),
    [reconciliation?.lines],
  );
  const availableJournalLines = useMemo(
    () => periodJournalLines.filter((line) => !matchedJournalLineIds.has(line.id)),
    [periodJournalLines, matchedJournalLineIds],
  );

  const [selectedTxnId, setSelectedTxnId] = useState("");
  const [selectedLineId, setSelectedLineId] = useState("");
  const [saving, setSaving] = useState(false);
  const [autoMatching, setAutoMatching] = useState(false);
  const [txnSearch, setTxnSearch] = useState("");
  const [txnMin, setTxnMin] = useState("");
  const [txnMax, setTxnMax] = useState("");
  const [txnStart, setTxnStart] = useState(() => searchParams.get("txnStart") || "");
  const [txnEnd, setTxnEnd] = useState(() => searchParams.get("txnEnd") || "");
  const [lineSearch, setLineSearch] = useState("");
  const [lineMin, setLineMin] = useState("");
  const [lineMax, setLineMax] = useState("");
  const [lineStart, setLineStart] = useState(() => searchParams.get("lineStart") || "");
  const [lineEnd, setLineEnd] = useState(() => searchParams.get("lineEnd") || "");
  const [lineRangeInitialized, setLineRangeInitialized] = useState(false);
  const [lineTolerance, setLineTolerance] = useState("0.00");
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeChecklist, setCloseChecklist] = useState<ReconciliationChecklist | null>(null);
  const [closing, setClosing] = useState(false);
  const [autoMatchConfirmOpen, setAutoMatchConfirmOpen] = useState(false);
  const [pendingAutoMatchMode, setPendingAutoMatchMode] = useState<AutoMatchMode | null>(null);
  const [showOnlyUnmatchedTxns, setShowOnlyUnmatchedTxns] = useState(false);
  const [showOnlyUnmatchedLines, setShowOnlyUnmatchedLines] = useState(true);
  const [lastAutoMatchResult, setLastAutoMatchResult] = useState<AutoMatchResult | null>(null);
  const [lastAutoMatchBatchTxnIds, setLastAutoMatchBatchTxnIds] = useState<string[]>([]);
  const [undoingAutoMatch, setUndoingAutoMatch] = useState(false);
  const [forceCloseReason, setForceCloseReason] = useState("");

  const isAdmin = authSession?.user?.role === "ADMIN";

  const logWorkspaceActivity = async (payload: {
    event: "auto_match_run" | "undo_auto_batch";
    mode?: AutoMatchMode;
    matchedCount?: number;
    attemptedCount?: number;
    revertedCount?: number;
  }) => {
    if (!reconciliationId) return;
    try {
      await fetch(`/api/admin/accounting/reconciliations/${reconciliationId}/activity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      queryClient.invalidateQueries({
        queryKey: ["accounting", "reconciliation", reconciliationId, "activity"],
      });
    } catch {
      // best effort activity logging
    }
  };

  const matchSelected = async () => {
    if (reconciliation?.status === "CLOSED") {
      toast.error("Reconciliation is closed.");
      return;
    }
    if (!selectedTxnId) {
      toast.error("Select a bank transaction.");
      return;
    }
    try {
      setSaving(true);
      const res = await fetch(`/api/admin/accounting/reconciliations/${reconciliationId}/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankTransactionId: selectedTxnId,
          journalLineId: selectedLineId || null,
          matchStatus: selectedLineId ? "MATCHED" : "UNMATCHED",
          source: "manual",
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to match transaction");
      toast.success("Match saved.");
      setSelectedTxnId("");
      setSelectedLineId("");
      queryClient.invalidateQueries({
        queryKey: ["accounting", "bank-transactions", bankAccountId],
      });
      queryClient.invalidateQueries({
        queryKey: ["accounting", "reconciliation", reconciliationId],
      });
      queryClient.invalidateQueries({
        queryKey: ["accounting", "reconciliation", reconciliationId, "activity"],
      });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to match.");
    } finally {
      setSaving(false);
    }
  };

  const selectedTxn = scopedBankTxns.find((txn) => txn.id === selectedTxnId);
  const selectedLine = periodJournalLines.find((line) => line.id === selectedLineId) || null;
  const isClosed = reconciliation?.status === "CLOSED";
  const hasAmountSignMismatch = useMemo(() => {
    if (!selectedTxn || !selectedLine) return false;
    const lineDebit = Number(selectedLine.debit || 0);
    const lineCredit = Number(selectedLine.credit || 0);
    if (selectedTxn.type === "CREDIT") {
      return lineCredit > 0 && lineDebit <= 0;
    }
    return lineDebit > 0 && lineCredit <= 0;
  }, [selectedTxn, selectedLine]);

  const matchesRule = useCallback((txn: BankTransaction, rule: BankMatchRule) => {
    if (!rule.isActive) return false;
    const text = `${txn.description || ""} ${txn.reference || ""}`.toLowerCase();
    const needle = rule.matchText.toLowerCase();
    let matched = false;
    switch (rule.matchMode) {
      case "STARTS_WITH":
        matched = text.startsWith(needle);
        break;
      case "ENDS_WITH":
        matched = text.endsWith(needle);
        break;
      case "REGEX":
        try {
          matched = new RegExp(rule.matchText, "i").test(text);
        } catch {
          matched = false;
        }
        break;
      default:
        matched = text.includes(needle);
    }
    if (!matched) return false;
    const amount = Math.abs(Number(txn.amount || 0));
    const min = rule.minAmount === null || rule.minAmount === undefined ? null : Number(rule.minAmount);
    const max = rule.maxAmount === null || rule.maxAmount === undefined ? null : Number(rule.maxAmount);
    if (min !== null && Number.isFinite(min) && amount < min) return false;
    if (max !== null && Number.isFinite(max) && amount > max) return false;
    return true;
  }, []);

  const selectedRule = useMemo(() => {
    if (!selectedTxn) return null;
    return (matchRules || [])
      .slice()
      .find((rule) => matchesRule(selectedTxn, rule)) || null;
  }, [selectedTxn, matchRules, matchesRule]);

  const loadCloseChecklist = async () => {
    if (!reconciliationId) return;
    const res = await fetch(`/api/admin/accounting/reconciliations/${reconciliationId}/checklist`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(j?.error || "Failed to load checklist.");
    }
    setCloseChecklist({
      unmatchedBankTxns: Number(j.unmatchedBankTxns || 0),
      unmatchedJournalLines: Number(j.unmatchedJournalLines || 0),
    });
  };

  const handleCloseOpen = async (open: boolean) => {
    setCloseOpen(open);
    if (!open) {
      setForceCloseReason("");
    }
    if (open) {
      try {
        await loadCloseChecklist();
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : "Failed to load checklist.");
      }
    }
  };

  const closeReconciliation = async (force?: boolean) => {
    if (!reconciliationId) return;
    if (force && !isAdmin) {
      toast.error("Only admins can force-close reconciliations.");
      return;
    }
    if (force && forceCloseReason.trim().length < 8) {
      toast.error("Provide a force-close reason (at least 8 characters).");
      return;
    }
    try {
      setClosing(true);
      const res = await fetch(`/api/admin/accounting/reconciliations/${reconciliationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          force: Boolean(force),
          forceReason: force ? forceCloseReason.trim() : undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (j?.unmatchedBankTxns !== undefined || j?.unmatchedJournalLines !== undefined) {
          setCloseChecklist({
            unmatchedBankTxns: Number(j.unmatchedBankTxns || 0),
            unmatchedJournalLines: Number(j.unmatchedJournalLines || 0),
          });
        }
        throw new Error(j?.error || "Failed to close reconciliation.");
      }
      toast.success("Reconciliation closed.");
      queryClient.invalidateQueries({ queryKey: ["accounting", "reconciliation", reconciliationId] });
      if (reconciliation?.bankAccountId) {
        queryClient.invalidateQueries({
          queryKey: ["accounting", "bank-transactions", reconciliation.bankAccountId],
        });
      }
      queryClient.invalidateQueries({
        queryKey: ["accounting", "reconciliation", reconciliationId, "activity"],
      });
      setCloseOpen(false);
      setCloseChecklist(null);
      setForceCloseReason("");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to close reconciliation.");
    } finally {
      setClosing(false);
    }
  };

  const parseMaybeNumber = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const filteredTxns = useMemo(() => {
    const min = parseMaybeNumber(txnMin);
    const max = parseMaybeNumber(txnMax);
    const startDate = txnStart ? new Date(txnStart) : null;
    const endDate = txnEnd ? new Date(txnEnd) : null;
    const q = txnSearch.trim().toLowerCase();
    return scopedBankTxns.filter((txn) => {
      if (showOnlyUnmatchedTxns && txn.matched) return false;
      const amt = Number(txn.amount || 0);
      if (min !== null && amt < min) return false;
      if (max !== null && amt > max) return false;
      if (startDate && new Date(txn.postedAt) < startDate) return false;
      if (endDate && new Date(txn.postedAt) > endDate) return false;
      if (q) {
        const hay = `${txn.description || ""} ${txn.reference || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [scopedBankTxns, txnMin, txnMax, txnStart, txnEnd, txnSearch, showOnlyUnmatchedTxns]);

  const unmatchedTxnCount = useMemo(() => {
    const start = txnStart ? new Date(txnStart) : null;
    const end = txnEnd ? new Date(txnEnd) : null;
    return scopedBankTxns.filter((txn) => {
      if (txn.matched) return false;
      const date = new Date(txn.postedAt);
      if (start && date < start) return false;
      if (end && date > end) return false;
      return true;
    }).length;
  }, [scopedBankTxns, txnStart, txnEnd]);
  const readyToClose = scopedBankTxns.length > 0 && unmatchedTxnCount === 0;
  const unmatchedLineCount = useMemo(() => {
    if (!reconciliation) return 0;
    const start = lineStart ? new Date(lineStart) : new Date(reconciliation.periodStart);
    const end = lineEnd ? new Date(lineEnd) : new Date(reconciliation.periodEnd);
    const inPeriod = periodJournalLines.filter((line) => {
      const date = new Date(line.entry.entryDate);
      return date >= start && date <= end;
    });
    return inPeriod.filter((line) => !matchedJournalLineIds.has(line.id)).length;
  }, [reconciliation, periodJournalLines, lineStart, lineEnd, matchedJournalLineIds]);

  const clearTxnFilters = () => {
    setTxnSearch("");
    setTxnMin("");
    setTxnMax("");
    setTxnStart("");
    setTxnEnd("");
  };

  const filteredLines = useMemo(() => {
    const sourceLines = showOnlyUnmatchedLines ? availableJournalLines : periodJournalLines;
    const min = parseMaybeNumber(lineMin);
    const max = parseMaybeNumber(lineMax);
    const startDate = lineStart ? new Date(lineStart) : null;
    const endDate = lineEnd ? new Date(lineEnd) : null;
    const q = lineSearch.trim().toLowerCase();
    return sourceLines.filter((line) => {
      const amt = Number(line.debit || 0) || Number(line.credit || 0);
      if (min !== null && amt < min) return false;
      if (max !== null && amt > max) return false;
      if (startDate && new Date(line.entry.entryDate) < startDate) return false;
      if (endDate && new Date(line.entry.entryDate) > endDate) return false;
      if (q) {
        const hay = `${line.account.code} ${line.account.name} ${line.description || ""} ${line.entry.memo || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [availableJournalLines, periodJournalLines, lineMin, lineMax, lineStart, lineEnd, lineSearch, showOnlyUnmatchedLines]);

  const unmatchedTxnHints = useMemo(() => {
    const hints = new Map<string, string>();
    const activeRules = (matchRules || []).filter((rule) => rule.isActive);
    const lineStartDate = lineStart ? new Date(lineStart) : null;
    const lineEndDate = lineEnd ? new Date(lineEnd) : null;
    const isWithinLineDateFilter = (lineDateText: string) => {
      const lineDate = new Date(lineDateText);
      if (lineStartDate && lineDate < lineStartDate) return false;
      if (lineEndDate && lineDate > lineEndDate) return false;
      return true;
    };

    for (const txn of scopedBankTxns) {
      if (txn.matched) continue;
      if (availableJournalLines.length === 0) {
        hints.set(txn.id, "No unmatched journal lines available.");
        continue;
      }
      const txnAmount = Math.abs(Number(txn.amount || 0));
      const hasExactAny = availableJournalLines.some((line) => {
        const amount = Math.abs(Number(line.debit || 0) || Number(line.credit || 0));
        return Math.abs(amount - txnAmount) < 0.01;
      });
      const hasExactInDateWindow = availableJournalLines.some((line) => {
        const amount = Math.abs(Number(line.debit || 0) || Number(line.credit || 0));
        if (Math.abs(amount - txnAmount) >= 0.01) return false;
        return isWithinLineDateFilter(line.entry.entryDate);
      });
      const matchedRule = activeRules.find((rule) => matchesRule(txn, rule));
      if (hasExactAny && !hasExactInDateWindow) {
        hints.set(txn.id, "Date out-of-range in current journal line date filter.");
        continue;
      }
      if (matchedRule) {
        const tolerance = Math.max(0, Number(matchedRule.amountTolerance || 0));
        const hasRuleLineWithinTolerance = availableJournalLines.some((line) => {
          if (matchedRule.accountId && line.accountId !== matchedRule.accountId) return false;
          const amount = Math.abs(Number(line.debit || 0) || Number(line.credit || 0));
          return Math.abs(amount - txnAmount) <= tolerance;
        });
        if (!hasRuleLineWithinTolerance) {
          hints.set(
            txn.id,
            `Rule matched but no journal line within tolerance (+/- ${tolerance.toFixed(2)}).`,
          );
          continue;
        }
      } else if (activeRules.length > 0) {
        hints.set(txn.id, "Rule miss: no active bank rule matched this transaction.");
        continue;
      }
      if (!hasExactAny) {
        hints.set(txn.id, "Amount mismatch: no exact-amount journal line found.");
      }
    }
    return hints;
  }, [availableJournalLines, lineEnd, lineStart, matchRules, matchesRule, scopedBankTxns]);

  const suggestedLines = useMemo<Array<{ line: JournalLine; score: number; amount: number }>>(() => {
    if (!selectedTxn) return [];
    const targetAmount = Math.abs(Number(selectedTxn.amount || 0));
    const targetDate = new Date(selectedTxn.postedAt).getTime();
    const tolerance = selectedRule ? Math.max(0, Number(selectedRule.amountTolerance || 0)) : null;
    const ruleAccountId = selectedRule?.accountId || null;
    const candidates = (ruleAccountId
      ? filteredLines.filter((line) => line.accountId === ruleAccountId)
      : filteredLines
    ).filter((line) => {
      const amount = Math.abs(Number(line.debit || 0) || Number(line.credit || 0));
      if (!Number.isFinite(amount) || amount <= 0) return false;
      if (tolerance !== null && Math.abs(amount - targetAmount) > tolerance) return false;
      return true;
    });

    const source = candidates.length > 0 ? candidates : filteredLines;
    const scored: Array<{ line: JournalLine; score: number; amount: number }> = [];
    for (const line of source) {
      const amount = Math.abs(Number(line.debit || 0) || Number(line.credit || 0));
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const amountScore = Math.abs(amount - targetAmount);
      const dateScore = Math.abs(new Date(line.entry.entryDate).getTime() - targetDate) / 86400000;
      const score = amountScore * 10 + dateScore;
      scored.push({ line, score, amount });
    }
    return scored.sort((a, b) => a.score - b.score).slice(0, 3);
  }, [selectedTxn, filteredLines, selectedRule]);

  useEffect(() => {
    if (!selectedTxn || selectedLineId) return;
    const targetAmount = Math.abs(Number(selectedTxn.amount || 0));
    const targetDate = new Date(selectedTxn.postedAt).getTime();
    const tolerance = selectedRule ? Math.max(0, Number(selectedRule.amountTolerance || 0)) : null;
    const ruleAccountId = selectedRule?.accountId || null;
    let bestId = "";
    let bestScore = Number.POSITIVE_INFINITY;
    const pool = ruleAccountId
      ? filteredLines.filter((line) => line.accountId === ruleAccountId)
      : filteredLines;
    for (const line of pool) {
      const amount = Math.abs(Number(line.debit || 0) || Number(line.credit || 0));
      if (!Number.isFinite(amount) || amount <= 0) continue;
      if (tolerance !== null && Math.abs(amount - targetAmount) > tolerance) continue;
      const amountScore = Math.abs(amount - targetAmount);
      const dateScore = Math.abs(new Date(line.entry.entryDate).getTime() - targetDate) / 86400000;
      const score = amountScore * 10 + dateScore;
      if (score < bestScore) {
        bestScore = score;
        bestId = line.id;
      }
    }
    if (bestId) setSelectedLineId(bestId);
  }, [selectedTxn, selectedLineId, filteredLines, selectedRule]);

  useEffect(() => {
    if (!selectedTxn) return;
    if (lineMin || lineMax) return;
    const amount = Math.abs(Number(selectedTxn.amount || 0));
    if (!Number.isFinite(amount) || amount <= 0) return;
    const tolerance = Math.max(0, Number(lineTolerance || 0));
    const min = Math.max(0, amount - tolerance).toFixed(2);
    const max = (amount + tolerance).toFixed(2);
    setLineMin(min);
    setLineMax(max);
  }, [selectedTxn, lineMin, lineMax, lineTolerance]);

  useEffect(() => {
    if (!reconciliation || lineRangeInitialized) return;
    const periodStart = reconciliation.periodStart.slice(0, 10);
    const periodEnd = reconciliation.periodEnd.slice(0, 10);
    if (!lineStart) setLineStart(periodStart);
    if (!lineEnd) setLineEnd(periodEnd);
    setLineRangeInitialized(true);
  }, [reconciliation, lineRangeInitialized, lineStart, lineEnd]);

  const clearLineFilters = () => {
    setLineSearch("");
    setLineMin("");
    setLineMax("");
    setLineStart("");
    setLineEnd("");
    setLineTolerance("0.00");
  };

  const clearSelection = () => {
    setSelectedTxnId("");
    setSelectedLineId("");
  };

  const applyTopSuggestion = () => {
    const firstSuggestion = suggestedLines[0];
    if (firstSuggestion) {
      setSelectedLineId(firstSuggestion.line.id);
    }
  };

  const autoMatchExact = async () => {
    if (!reconciliationId) return;
    if (!scopedBankTxns || scopedBankTxns.length === 0 || availableJournalLines.length === 0) {
      toast.error("Nothing to match yet.");
      return;
    }
    try {
      setAutoMatching(true);
      let matchedCount = 0;
      const unmatchedTxns = scopedBankTxns.filter((t) => !t.matched);
      const matchedTxnIds: string[] = [];
      const skipped: AutoMatchSkip[] = [];
      const availableLines = availableJournalLines.slice();
      for (const txn of unmatchedTxns) {
        const txnAmount = Number(txn.amount || 0);
        const lineIndex = availableLines.findIndex((line) => {
          const amt = Number(line.debit || 0) || Number(line.credit || 0);
          return Math.abs(amt - txnAmount) < 0.01;
        });
        if (lineIndex === -1) {
          skipped.push({ txnId: txn.id, reason: "No exact amount line available." });
          continue;
        }
        const line = availableLines.splice(lineIndex, 1)[0];
        const res = await fetch(
          `/api/admin/accounting/reconciliations/${reconciliationId}/match`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bankTransactionId: txn.id,
              journalLineId: line.id,
              matchStatus: "MATCHED",
              source: "auto_exact",
            }),
          },
        );
        if (res.ok) {
          matchedCount += 1;
          matchedTxnIds.push(txn.id);
        } else {
          const j = await res.json().catch(() => ({}));
          skipped.push({ txnId: txn.id, reason: String(j?.error || "Match API rejected row.") });
        }
      }
      setLastAutoMatchResult({
        mode: "exact",
        matchedCount,
        attemptedCount: unmatchedTxns.length,
        matchedTxnIds,
        skipped,
        at: new Date().toISOString(),
      });
      setLastAutoMatchBatchTxnIds(matchedTxnIds);
      if (matchedCount > 0) {
        toast.success(`Auto-matched ${matchedCount} transaction(s).`);
      } else {
        toast.info("No exact amount matches found.");
      }
      await logWorkspaceActivity({
        event: "auto_match_run",
        mode: "exact",
        matchedCount,
        attemptedCount: unmatchedTxns.length,
      });
      queryClient.invalidateQueries({
        queryKey: ["accounting", "bank-transactions", bankAccountId],
      });
      queryClient.invalidateQueries({
        queryKey: ["accounting", "reconciliation", reconciliationId],
      });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Auto-match failed.");
    } finally {
      setAutoMatching(false);
    }
  };

  const autoMatchWithinTolerance = async () => {
    if (!reconciliationId) return;
    const tolerance = Math.max(0, Number(lineTolerance || 0));
    if (!(tolerance > 0)) {
      toast.error("Set a tolerance greater than 0 to use this feature.");
      return;
    }
    if (!scopedBankTxns || scopedBankTxns.length === 0 || availableJournalLines.length === 0) {
      toast.error("Nothing to match yet.");
      return;
    }
    try {
      setAutoMatching(true);
      let matchedCount = 0;
      const unmatchedTxns = scopedBankTxns.filter((t) => !t.matched);
      const matchedTxnIds: string[] = [];
      const skipped: AutoMatchSkip[] = [];
      const availableLines = availableJournalLines.slice();
      for (const txn of unmatchedTxns) {
        const txnAmount = Number(txn.amount || 0);
        const lineIndex = availableLines.findIndex((line) => {
          const amt = Number(line.debit || 0) || Number(line.credit || 0);
          return Math.abs(amt - txnAmount) <= tolerance;
        });
        if (lineIndex === -1) {
          skipped.push({ txnId: txn.id, reason: `No line within tolerance (+/- ${tolerance.toFixed(2)}).` });
          continue;
        }
        const line = availableLines.splice(lineIndex, 1)[0];
        const res = await fetch(
          `/api/admin/accounting/reconciliations/${reconciliationId}/match`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bankTransactionId: txn.id,
              journalLineId: line.id,
              matchStatus: "MATCHED",
              source: "auto_tolerance",
            }),
          },
        );
        if (res.ok) {
          matchedCount += 1;
          matchedTxnIds.push(txn.id);
        } else {
          const j = await res.json().catch(() => ({}));
          skipped.push({ txnId: txn.id, reason: String(j?.error || "Match API rejected row.") });
        }
      }
      setLastAutoMatchResult({
        mode: "tolerance",
        matchedCount,
        attemptedCount: unmatchedTxns.length,
        matchedTxnIds,
        skipped,
        at: new Date().toISOString(),
      });
      setLastAutoMatchBatchTxnIds(matchedTxnIds);
      if (matchedCount > 0) {
        toast.success(`Auto-matched ${matchedCount} transaction(s).`);
      } else {
        toast.info("No matches found within tolerance.");
      }
      await logWorkspaceActivity({
        event: "auto_match_run",
        mode: "tolerance",
        matchedCount,
        attemptedCount: unmatchedTxns.length,
      });
      queryClient.invalidateQueries({
        queryKey: ["accounting", "bank-transactions", bankAccountId],
      });
      queryClient.invalidateQueries({
        queryKey: ["accounting", "reconciliation", reconciliationId],
      });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Auto-match failed.");
    } finally {
      setAutoMatching(false);
    }
  };

  const autoMatchByRules = async () => {
    if (!reconciliationId) return;
    const rules = (matchRules || [])
      .filter((rule) => rule.isActive && rule.accountId);
    if (rules.length === 0) {
      toast.error("No active rules with account mapping.");
      return;
    }
    if (!scopedBankTxns || scopedBankTxns.length === 0 || availableJournalLines.length === 0) {
      toast.error("Nothing to match yet.");
      return;
    }
    try {
      setAutoMatching(true);
      let matchedCount = 0;
      const unmatchedTxns = scopedBankTxns.filter((t) => !t.matched);
      const matchedTxnIds: string[] = [];
      const skipped: AutoMatchSkip[] = [];
      const availableLines = availableJournalLines.slice();
      for (const txn of unmatchedTxns) {
        const rule = rules.find((r) => matchesRule(txn, r));
        if (!rule || !rule.accountId) {
          skipped.push({ txnId: txn.id, reason: "No active rule matched this transaction." });
          continue;
        }
        const tolerance = Math.max(0, Number(rule.amountTolerance || 0));
        const txnAmount = Math.abs(Number(txn.amount || 0));
        let bestIndex = -1;
        let bestScore = Number.POSITIVE_INFINITY;
        for (let i = 0; i < availableLines.length; i += 1) {
          const line = availableLines[i];
          if (line.accountId !== rule.accountId) continue;
          const amt = Math.abs(Number(line.debit || 0) || Number(line.credit || 0));
          if (!Number.isFinite(amt) || amt <= 0) continue;
          if (Math.abs(amt - txnAmount) > tolerance) continue;
          const dateScore =
            Math.abs(new Date(line.entry.entryDate).getTime() - new Date(txn.postedAt).getTime()) / 86400000;
          const amountScore = Math.abs(amt - txnAmount);
          const score = amountScore * 10 + dateScore;
          if (score < bestScore) {
            bestScore = score;
            bestIndex = i;
          }
        }
        if (bestIndex === -1) {
          skipped.push({ txnId: txn.id, reason: `Rule matched but no line within tolerance (+/- ${tolerance.toFixed(2)}).` });
          continue;
        }
        const line = availableLines.splice(bestIndex, 1)[0];
        const res = await fetch(
          `/api/admin/accounting/reconciliations/${reconciliationId}/match`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bankTransactionId: txn.id,
              journalLineId: line.id,
              matchStatus: "MATCHED",
              source: "auto_rules",
            }),
          },
        );
        if (res.ok) {
          matchedCount += 1;
          matchedTxnIds.push(txn.id);
        } else {
          const j = await res.json().catch(() => ({}));
          skipped.push({ txnId: txn.id, reason: String(j?.error || "Match API rejected row.") });
        }
      }
      setLastAutoMatchResult({
        mode: "rules",
        matchedCount,
        attemptedCount: unmatchedTxns.length,
        matchedTxnIds,
        skipped,
        at: new Date().toISOString(),
      });
      setLastAutoMatchBatchTxnIds(matchedTxnIds);
      if (matchedCount > 0) {
        toast.success(`Auto-matched ${matchedCount} transaction(s).`);
      } else {
        toast.info("No matches found for active rules.");
      }
      await logWorkspaceActivity({
        event: "auto_match_run",
        mode: "rules",
        matchedCount,
        attemptedCount: unmatchedTxns.length,
      });
      queryClient.invalidateQueries({
        queryKey: ["accounting", "bank-transactions", bankAccountId],
      });
      queryClient.invalidateQueries({
        queryKey: ["accounting", "reconciliation", reconciliationId],
      });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Auto-match failed.");
    } finally {
      setAutoMatching(false);
    }
  };

  const openAutoMatchConfirm = (mode: AutoMatchMode) => {
    if (!reconciliationId) return;
    if (!scopedBankTxns || scopedBankTxns.length === 0 || availableJournalLines.length === 0) {
      toast.error("Nothing to match yet.");
      return;
    }
    if (mode === "tolerance") {
      const tolerance = Math.max(0, Number(lineTolerance || 0));
      if (!(tolerance > 0)) {
        toast.error("Set a tolerance greater than 0 to use this feature.");
        return;
      }
    }
    if (mode === "rules") {
      const rules = (matchRules || []).filter((rule) => rule.isActive && rule.accountId);
      if (rules.length === 0) {
        toast.error("No active rules with account mapping.");
        return;
      }
    }
    setPendingAutoMatchMode(mode);
    setAutoMatchConfirmOpen(true);
  };

  const confirmAutoMatch = async () => {
    const mode = pendingAutoMatchMode;
    if (!mode) return;
    setAutoMatchConfirmOpen(false);
    setPendingAutoMatchMode(null);
    if (mode === "exact") {
      await autoMatchExact();
      return;
    }
    if (mode === "tolerance") {
      await autoMatchWithinTolerance();
      return;
    }
    await autoMatchByRules();
  };

  const undoLastAutoMatch = async () => {
    if (!reconciliationId) return;
    if (!lastAutoMatchBatchTxnIds.length) {
      toast.error("No auto-match batch to undo.");
      return;
    }
    try {
      setUndoingAutoMatch(true);
      let reverted = 0;
      for (const txnId of lastAutoMatchBatchTxnIds) {
        const res = await fetch(`/api/admin/accounting/reconciliations/${reconciliationId}/match`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bankTransactionId: txnId,
            journalLineId: null,
            matchStatus: "UNMATCHED",
            source: "undo_auto",
          }),
        });
        if (res.ok) reverted += 1;
      }
      if (reverted > 0) {
        toast.success(`Reverted ${reverted} auto-matched transaction(s).`);
        setLastAutoMatchBatchTxnIds([]);
      } else {
        toast.error("Could not revert auto-match batch.");
      }
      await logWorkspaceActivity({
        event: "undo_auto_batch",
        revertedCount: reverted,
      });
      queryClient.invalidateQueries({
        queryKey: ["accounting", "bank-transactions", bankAccountId],
      });
      queryClient.invalidateQueries({
        queryKey: ["accounting", "reconciliation", reconciliationId],
      });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Undo failed.");
    } finally {
      setUndoingAutoMatch(false);
    }
  };

  const downloadAutoMatchSkipReport = () => {
    if (!lastAutoMatchResult || !lastAutoMatchResult.skipped.length) {
      toast.error("No skip report to download.");
      return;
    }
    const csv = [
      "txnId,reason",
      ...lastAutoMatchResult.skipped.map((row) => `"${row.txnId.replace(/"/g, '""')}","${row.reason.replace(/"/g, '""')}"`),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `auto-match-skips-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  };

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (txnStart) params.set("txnStart", txnStart);
    else params.delete("txnStart");
    if (txnEnd) params.set("txnEnd", txnEnd);
    else params.delete("txnEnd");
    if (lineStart) params.set("lineStart", lineStart);
    else params.delete("lineStart");
    if (lineEnd) params.set("lineEnd", lineEnd);
    else params.delete("lineEnd");
    const next = params.toString();
    const current = searchParams.toString();
    if (next !== current) {
      router.replace(next ? `?${next}` : "?", { scroll: false });
    }
  }, [txnStart, txnEnd, lineStart, lineEnd, router, searchParams]);

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Reconciliation Match</h1>
          <p className="text-sm text-muted-foreground">
            Match bank transactions to journal entries for{" "}
            {reconciliation?.bankAccount?.name || "bank account"}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {reconciliationId ? (
            <Button asChild variant="outline" size="sm">
              <a href={`/api/admin/accounting/reconciliations/${reconciliationId}/export`}>
                Export CSV
              </a>
            </Button>
          ) : null}
          {!isClosed ? (
            <Button size="sm" variant="destructive" onClick={() => handleCloseOpen(true)}>
              Close reconciliation
            </Button>
          ) : null}
        </div>
      </div>
      {!isClosed ? (
        <Card>
          <CardContent className="py-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className={readyToClose ? "text-emerald-700" : "text-amber-700"}>
                {readyToClose
                  ? "Close readiness: all bank transactions are matched."
                  : `Close readiness: ${unmatchedTxnCount} unmatched transaction(s) and ${Math.max(0, unmatchedLineCount)} unmatched journal line(s).`}
              </div>
              <Button size="sm" variant={readyToClose ? "default" : "outline"} onClick={() => handleCloseOpen(true)}>
                Review close checklist
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {isClosed ? (
        <Card>
          <CardContent className="text-sm text-muted-foreground py-4">
            This reconciliation is closed. Matching is locked.
          </CardContent>
        </Card>
      ) : null}

      <Dialog open={closeOpen} onOpenChange={handleCloseOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Close reconciliation?</DialogTitle>
          </DialogHeader>
          <div className="text-sm space-y-2">
            <p className="text-muted-foreground">
              Review the checklist before closing this reconciliation.
            </p>
            <div className="flex justify-between">
              <span>Unmatched bank transactions</span>
              <span>{closeChecklist?.unmatchedBankTxns ?? "-"}</span>
            </div>
            <div className="flex justify-between">
              <span>Unmatched journal lines</span>
              <span>{closeChecklist?.unmatchedJournalLines ?? "-"}</span>
            </div>
            {closeChecklist &&
            (closeChecklist.unmatchedBankTxns > 0 || closeChecklist.unmatchedJournalLines > 0) ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Force close keeps unmatched items. This action is restricted and audited.
                </p>
                {isAdmin ? (
                  <div className="space-y-1">
                    <label className="text-xs font-medium">Force-close reason (required)</label>
                    <Textarea
                      rows={3}
                      value={forceCloseReason}
                      onChange={(e) => setForceCloseReason(e.target.value)}
                      placeholder="Explain why close is being forced and what follow-up will be done."
                    />
                  </div>
                ) : (
                  <p className="text-xs text-amber-700">
                    Only ADMIN users can force-close when unmatched items remain.
                  </p>
                )}
              </div>
            ) : null}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setCloseOpen(false)}>
              Cancel
            </Button>
            {closeChecklist &&
            (closeChecklist.unmatchedBankTxns > 0 || closeChecklist.unmatchedJournalLines > 0) ? (
              <Button
                variant="destructive"
                onClick={() => closeReconciliation(true)}
                disabled={closing || !isAdmin || forceCloseReason.trim().length < 8}
              >
                {closing ? "Closing..." : "Close anyway"}
              </Button>
            ) : (
              <Button
                variant="destructive"
                onClick={() => closeReconciliation(false)}
                disabled={closing}
              >
                {closing ? "Closing..." : "Close reconciliation"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={autoMatchConfirmOpen}
        onOpenChange={(open) => {
          setAutoMatchConfirmOpen(open);
          if (!open) setPendingAutoMatchMode(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Run auto-match?</DialogTitle>
          </DialogHeader>
          <div className="text-sm space-y-2">
            <p className="text-xs text-muted-foreground">
              Pre-flight: {scopedBankTxns.filter((t) => !t.matched).length} unmatched transaction(s),{" "}
              {availableJournalLines.length} available journal line(s).
            </p>
            {pendingAutoMatchMode === "exact" ? (
              <p className="text-muted-foreground">
                This will auto-match unmatched transactions using exact amount equality.
              </p>
            ) : null}
            {pendingAutoMatchMode === "tolerance" ? (
              <p className="text-muted-foreground">
                This will auto-match unmatched transactions within +/- {Math.max(0, Number(lineTolerance || 0)).toFixed(2)}.
              </p>
            ) : null}
            {pendingAutoMatchMode === "rules" ? (
              <p className="text-muted-foreground">
                This will auto-match unmatched transactions using active bank rules and configured tolerances.
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Review results after completion before closing reconciliation.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setAutoMatchConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void confirmAutoMatch()} disabled={autoMatching}>
              {autoMatching ? "Auto-matching..." : "Run auto-match"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle>Bank transactions</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <div className="text-xs text-muted-foreground">
            Unmatched transactions: {unmatchedTxnCount} · Unmatched journal lines: {Math.max(0, unmatchedLineCount)}
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <Input placeholder="Search" value={txnSearch} onChange={(e) => setTxnSearch(e.target.value)} />
            <Input placeholder="Min amount" inputMode="decimal" value={txnMin} onChange={(e) => setTxnMin(e.target.value)} />
            <Input placeholder="Max amount" inputMode="decimal" value={txnMax} onChange={(e) => setTxnMax(e.target.value)} />
            <Input type="date" value={txnStart} onChange={(e) => setTxnStart(e.target.value)} />
            <Input type="date" value={txnEnd} onChange={(e) => setTxnEnd(e.target.value)} />
            <div className="sm:col-span-2 lg:col-span-5">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={clearTxnFilters}>
                  Clear filters
                </Button>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={showOnlyUnmatchedTxns}
                    onChange={(e) => setShowOnlyUnmatchedTxns(e.target.checked)}
                  />
                  Show only unmatched
                </label>
              </div>
            </div>
          </div>
          {filteredTxns.length === 0 ? (
            <p className="text-muted-foreground">No bank transactions found.</p>
          ) : (
            filteredTxns.map((txn) => (
              <button
                type="button"
                key={txn.id}
                className={`w-full text-left flex justify-between border-b py-1 ${
                  selectedTxnId === txn.id ? "font-semibold" : ""
                } ${isClosed ? "cursor-not-allowed opacity-60" : ""}`}
                onClick={() => setSelectedTxnId(txn.id)}
                disabled={isClosed}
              >
                <span>
                  {new Date(txn.postedAt).toLocaleDateString()} · {txn.description || "Transaction"}
                  {!txn.matched && unmatchedTxnHints.get(txn.id) ? (
                    <span className="block text-[11px] text-muted-foreground">
                      {unmatchedTxnHints.get(txn.id)}
                    </span>
                  ) : null}
                </span>
                <span>
                  {txn.type === "CREDIT" ? "+" : "-"}
                  {Number(txn.amount).toFixed(2)} {txn.matched ? "✓" : ""}
                </span>
              </button>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Journal lines</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <Input placeholder="Search" value={lineSearch} onChange={(e) => setLineSearch(e.target.value)} />
            <Input placeholder="Min amount" inputMode="decimal" value={lineMin} onChange={(e) => setLineMin(e.target.value)} />
            <Input placeholder="Max amount" inputMode="decimal" value={lineMax} onChange={(e) => setLineMax(e.target.value)} />
            <Input type="date" value={lineStart} onChange={(e) => setLineStart(e.target.value)} />
            <Input type="date" value={lineEnd} onChange={(e) => setLineEnd(e.target.value)} />
            <Input
              placeholder="Tolerance (GHS)"
              inputMode="decimal"
              value={lineTolerance}
              onChange={(e) => setLineTolerance(e.target.value)}
            />
            <div className="sm:col-span-2 lg:col-span-6">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={clearLineFilters}>
                  Clear filters
                </Button>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={showOnlyUnmatchedLines}
                    onChange={(e) => setShowOnlyUnmatchedLines(e.target.checked)}
                  />
                  Show only unmatched
                </label>
              </div>
            </div>
          </div>
          {availableJournalLines.length === 0 ? (
            <p className="text-muted-foreground">No journal lines found.</p>
          ) : (
            filteredLines.map((line) => {
              const amount = Number(line.debit || 0) || Number(line.credit || 0);
              return (
                <button
                  type="button"
                  key={line.id}
                  className={`w-full text-left flex justify-between border-b py-1 ${
                    selectedLineId === line.id ? "font-semibold" : ""
                  } ${isClosed ? "cursor-not-allowed opacity-60" : ""}`}
                  onClick={() => setSelectedLineId(line.id)}
                  disabled={isClosed}
                >
                  <span>
                    {new Date(line.entry.entryDate).toLocaleDateString()} · {line.account.code} {line.account.name}
                  </span>
                  <span>{amount.toFixed(2)}</span>
                </button>
              );
            })
          )}
        </CardContent>
      </Card>

      {selectedTxn ? (
        <Card>
          <CardHeader>
            <CardTitle>Suggested matches</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            {selectedRule ? (
              <p className="text-xs text-muted-foreground">
                Rule match: {selectedRule.name}
              </p>
            ) : null}
            {suggestedLines.length === 0 ? (
              <p className="text-muted-foreground">No close matches found.</p>
            ) : (
              suggestedLines.map((row) => (
                <button
                  key={row.line.id}
                  type="button"
                  className={`w-full text-left flex justify-between border-b py-1 ${
                    selectedLineId === row.line.id ? "font-semibold" : ""
                  } ${isClosed ? "cursor-not-allowed opacity-60" : ""}`}
                  onClick={() => setSelectedLineId(row.line.id)}
                  disabled={isClosed}
                >
                  <span>
                    {new Date(row.line.entry.entryDate).toLocaleDateString()} · {row.line.account.code} {row.line.account.name}
                  </span>
                  <span>{row.amount.toFixed(2)}</span>
                </button>
              ))
            )}
          </CardContent>
        </Card>
      ) : null}

      {hasAmountSignMismatch ? (
        <Card>
          <CardContent className="py-3 text-sm text-amber-700">
            Warning: selected transaction direction and selected journal line sign may not align. Review before saving match.
          </CardContent>
        </Card>
      ) : null}

      {lastAutoMatchResult ? (
        <Card>
          <CardHeader>
            <CardTitle>Last auto-match result</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              Mode: <span className="font-medium">{lastAutoMatchResult.mode}</span> | Matched{" "}
              <span className="font-medium">{lastAutoMatchResult.matchedCount}</span> of{" "}
              <span className="font-medium">{lastAutoMatchResult.attemptedCount}</span> attempted.
            </p>
            <p className="text-xs text-muted-foreground">
              Run time: {new Date(lastAutoMatchResult.at).toLocaleString()}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={downloadAutoMatchSkipReport}
                disabled={lastAutoMatchResult.skipped.length === 0}
              >
                Download skip report
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void undoLastAutoMatch()}
                disabled={undoingAutoMatch || lastAutoMatchBatchTxnIds.length === 0 || isClosed}
              >
                {undoingAutoMatch ? "Undoing..." : "Undo last auto-match batch"}
              </Button>
            </div>
            {lastAutoMatchResult.skipped.length > 0 ? (
              <div className="rounded-md border p-2 text-xs text-muted-foreground">
                <p className="mb-1 font-medium text-foreground">Top skip reasons</p>
                {lastAutoMatchResult.skipped.slice(0, 5).map((row) => (
                  <p key={`${row.txnId}:${row.reason}`}>{row.txnId}: {row.reason}</p>
                ))}
                {lastAutoMatchResult.skipped.length > 5 ? (
                  <p>+{lastAutoMatchResult.skipped.length - 5} more...</p>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Apply match</CardTitle>
        </CardHeader>
        <CardContent className="sticky bottom-4 z-10 rounded-md border bg-background/95 backdrop-blur">
          <div className="flex flex-wrap gap-2">
            <Button onClick={matchSelected} disabled={saving || isClosed}>
              {saving ? "Saving..." : "Save match"}
            </Button>
            <Button
              variant="outline"
              onClick={applyTopSuggestion}
              disabled={!selectedTxn || suggestedLines.length === 0 || isClosed}
            >
              Use top suggestion
            </Button>
            <Button variant="outline" onClick={() => openAutoMatchConfirm("exact")} disabled={autoMatching || isClosed}>
              {autoMatching ? "Auto-matching..." : "Auto-match exact amounts"}
            </Button>
            <Button variant="outline" onClick={() => openAutoMatchConfirm("tolerance")} disabled={autoMatching || isClosed}>
              {autoMatching ? "Auto-matching..." : "Auto-match within tolerance"}
            </Button>
            <Button variant="outline" onClick={() => openAutoMatchConfirm("rules")} disabled={autoMatching || isClosed}>
              {autoMatching ? "Auto-matching..." : "Auto-match by rules"}
            </Button>
            <Button variant="ghost" onClick={clearSelection} disabled={!selectedTxnId && !selectedLineId}>
              Clear selection
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workspace activity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-xs text-muted-foreground">
          {!persistedActivity || persistedActivity.length === 0 ? (
            <p>No events yet.</p>
          ) : (
            persistedActivity.map((event) => (
              <p key={event.id}>
                {new Date(event.at).toLocaleTimeString()} - {event.text}
                {event.actor ? ` (${event.actor})` : ""}
              </p>
            ))
          )}
        </CardContent>
      </Card>
    </section>
  );
}
