"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function EmployeePortalAcknowledgeButton({
  path,
  label,
  acknowledged,
}: {
  path: string;
  label: string;
  acknowledged: boolean;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const acknowledge = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(path, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Unable to save acknowledgement.");
      }
      toast.success("Acknowledgement saved.");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save acknowledgement.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Button type="button" size="sm" variant="outline" disabled={acknowledged || submitting} onClick={acknowledge}>
      {acknowledged ? `${label} acknowledged` : submitting ? "Saving..." : `Acknowledge ${label}`}
    </Button>
  );
}
