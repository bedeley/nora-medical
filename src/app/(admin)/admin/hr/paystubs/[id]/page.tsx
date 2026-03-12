"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/currency";
import Image from "next/image";
import { ADMIN_PHONE } from "@/lib/config";

type Payslip = {
  id: string;
  grossPay: number | string;
  netPay: number | string;
  lineItems?: Record<string, number> | null;
  employee: {
    firstName: string;
    lastName: string;
    email?: string | null;
    department?: string | null;
    position?: string | null;
  };
  payrollRun: { periodStart: string; periodEnd: string; status: string };
};

type PayslipResponse = {
  payslip: Payslip;
  ytdTotals: { gross: number; net: number; deductions: number; tax: number; pension: number };
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function num(v: unknown) {
  return Number(v || 0);
}

export default function PaystubPrintPage() {
  const params = useParams();
  const payslipId = useMemo(() => String(params?.id ?? ""), [params]);
  const [emailOpen, setEmailOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "hr", "paystub", payslipId],
    queryFn: () => fetcher(`/api/admin/hr/payslips/${payslipId}`),
    enabled: Boolean(payslipId),
  });

  const payload = data as PayslipResponse | undefined;
  const payslip = payload?.payslip;
  const ytd = payload?.ytdTotals;
  const lineItems = payslip?.lineItems ?? {};
  const deductions = Math.max(0, num(lineItems.deductions ?? num(payslip?.grossPay) - num(payslip?.netPay)));

  useEffect(() => {
    if (payslip?.employee?.email && !email) {
      setEmail(payslip.employee.email);
    }
  }, [payslip, email]);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading paystub...</p>;
  }

  if (!payslip) {
    return <p className="text-sm text-muted-foreground">Paystub not found.</p>;
  }

  const sendPaystub = async (targetEmail: string, closeDialog?: boolean) => {
    if (!targetEmail.trim()) {
      toast.error("Enter an email address.");
      return;
    }
    setSending(true);
    try {
      const res = await fetch(`/api/admin/hr/payslips/${payslipId}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: targetEmail.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to send paystub.");
        return;
      }
      toast.success("Paystub emailed.");
      if (closeDialog) setEmailOpen(false);
    } catch {
      toast.error("Failed to send paystub.");
    } finally {
      setSending(false);
    }
  };

  const handleEmail = async () => {
    await sendPaystub(email, true);
  };

  return (
    <section className="space-y-6 print:space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <h1 className="text-2xl font-bold">Paystub</h1>
        <div className="flex flex-wrap gap-2">
          <Dialog open={emailOpen} onOpenChange={setEmailOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">Email</Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Email Paystub</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3">
                <Input
                  type="email"
                  placeholder="employee@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="flex justify-end">
                <Button onClick={handleEmail} disabled={sending}>
                  {sending ? "Sending..." : "Send paystub"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          <Button variant="outline" onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </div>

      <Card className="print:shadow-none print:border">
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <Image src="/logo.svg" alt="Noralls Medical Supplies" width={140} height={44} />
              <div>
                <CardTitle>Noralls Medical Supplies</CardTitle>
                <p className="text-xs text-muted-foreground">Official Paystub</p>
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              <div>Phone: {ADMIN_PHONE}</div>
              <div>Paystub ID: {payslip.id}</div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6 text-sm">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="text-xs text-muted-foreground">Employee</div>
              <div className="font-medium">
                {payslip.employee.firstName} {payslip.employee.lastName}
              </div>
              <div className="text-xs text-muted-foreground">
                {payslip.employee.position || "—"} · {payslip.employee.department || "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Period</div>
              <div className="font-medium">
                {new Date(payslip.payrollRun.periodStart).toLocaleDateString()} -{" "}
                {new Date(payslip.payrollRun.periodEnd).toLocaleDateString()}
              </div>
              <div className="text-xs text-muted-foreground">Run Status</div>
              <div className="font-medium">{payslip.payrollRun.status}</div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Current</div>
              <div className="flex items-center justify-between">
                <span>Gross Pay</span>
                <span className="font-medium">{formatCurrency(num(payslip.grossPay))}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Net Pay</span>
                <span className="font-medium">{formatCurrency(num(payslip.netPay))}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Tax</span>
                <span className="font-medium">{formatCurrency(num(lineItems.tax))}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Pension</span>
                <span className="font-medium">{formatCurrency(num(lineItems.pension))}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Deductions</span>
                <span className="font-medium">{formatCurrency(deductions)}</span>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Year to Date</div>
              <div className="flex items-center justify-between">
                <span>Gross Pay</span>
                <span className="font-medium">{formatCurrency(num(ytd?.gross))}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Net Pay</span>
                <span className="font-medium">{formatCurrency(num(ytd?.net))}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Tax</span>
                <span className="font-medium">{formatCurrency(num(ytd?.tax))}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Pension</span>
                <span className="font-medium">{formatCurrency(num(ytd?.pension))}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Deductions</span>
                <span className="font-medium">{formatCurrency(num(ytd?.deductions))}</span>
              </div>
            </div>
          </div>
          <div className="border-t pt-4 text-xs text-muted-foreground">
            This paystub is confidential and intended for the employee named above.
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
