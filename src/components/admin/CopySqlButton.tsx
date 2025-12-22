"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal } from "lucide-react";

type CopySqlButtonProps = {
  sql: string;
};

export default function CopySqlButton({ sql }: CopySqlButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={handleCopy}>
      {copied ? "Copied" : "Copy SQL"}
    </Button>
  );
}

type RunFixButtonProps = {
  orderId: string;
  paymentId: string;
  onSuccess?: () => void;
};

export function RunFixButton({ orderId, paymentId, onSuccess }: RunFixButtonProps) {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const router = useRouter();

  const handleRun = async () => {
    if (!confirm("Link this payment to the order?")) return;
    setRunning(true);
    setDone(false);
    try {
      const res = await fetch("/api/admin/health/link-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, paymentId }),
      });
      if (!res.ok) {
        throw new Error("Failed to update payment");
      }
      toast.success("Payment linked to order.");
      setDone(true);
      onSuccess?.();
      router.refresh();
      window.setTimeout(() => setDone(false), 1500);
    } catch {
      toast.error("Could not link payment.");
      setDone(false);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={handleRun} disabled={running}>
      {running ? "Running..." : done ? "Fixed" : "Run Fix"}
    </Button>
  );
}

type FixActionsProps = {
  sql: string;
  orderId: string;
  paymentId: string;
};

export function FixActionsMenu({ sql, orderId, paymentId }: FixActionsProps) {
  const [copied, setCopied] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const router = useRouter();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      toast.success("SQL copied.");
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy SQL.");
      setCopied(false);
    }
  };

  const handleRun = async () => {
    if (!confirm("Link this payment to the order?")) return;
    setRunning(true);
    setDone(false);
    try {
      const res = await fetch("/api/admin/health/link-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, paymentId }),
      });
      if (!res.ok) {
        throw new Error("Failed to update payment");
      }
      toast.success("Payment linked to order.");
      setDone(true);
      router.refresh();
      window.setTimeout(() => setDone(false), 1500);
    } catch {
      toast.error("Could not link payment.");
      setDone(false);
    } finally {
      setRunning(false);
    }
  };

  const label = running ? "Running..." : done ? "Fixed" : "Actions";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={running}>
          <MoreHorizontal className="h-4 w-4 mr-2" />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={handleRun}>
          {running ? "Running..." : done ? "Fixed" : "Run Fix"}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleCopy}>
          {copied ? "Copied" : "Copy SQL"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type BackfillAutoApplyButtonProps = {
  paymentId: string;
  onSuccess?: () => void;
};

export function BackfillAutoApplyButton({
  paymentId,
  onSuccess,
}: BackfillAutoApplyButtonProps) {
  const [running, setRunning] = useState(false);
  const router = useRouter();

  const handleRun = async () => {
    if (!confirm("Link this legacy AUTO_APPLY payment to its order?")) return;
    setRunning(true);
    try {
      const res = await fetch("/api/admin/health/backfill-auto-apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to backfill payment");
      toast.success("Legacy AUTO_APPLY payment linked.");
      onSuccess?.();
      router.refresh();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Could not backfill payment.";
      toast.error(message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={handleRun} disabled={running}>
      {running ? "Linking..." : "Backfill"}
    </Button>
  );
}
