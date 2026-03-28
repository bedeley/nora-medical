"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function EmployeePaystubPrintButton({ payslipId }: { payslipId: string }) {
  const [printing, setPrinting] = useState(false);

  return (
    <Button
      type="button"
      variant="outline"
      disabled={printing}
      onClick={async () => {
        try {
          setPrinting(true);
          const response = await fetch(`/api/account/employee/payslips/${payslipId}/print`, {
            method: "POST",
          });
          const body = await response.json().catch(() => ({} as { error?: string }));
          if (!response.ok) {
            throw new Error(body.error || "Unable to open print.");
          }
          window.print();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unable to open print.";
          toast.error(message);
        } finally {
          setPrinting(false);
        }
      }}
    >
      {printing ? "Opening print..." : "Print paystub"}
    </Button>
  );
}
