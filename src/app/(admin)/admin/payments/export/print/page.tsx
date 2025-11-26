"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

function parseCSV(csv: string) {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length === 0) return { header: [], rows: [] as string[][] };
  const parseLine = (line: string) => {
    // very simple CSV parser for quoted cells
    const cells: string[] = [];
    let cur = ""; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') { inQ = false; }
        else { cur += ch; }
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ',') { cells.push(cur); cur = ""; }
        else { cur += ch; }
      }
    }
    cells.push(cur);
    return cells;
  };
  const header = parseLine(lines[0] || "");
  const rows = lines.slice(1).map(parseLine);
  return { header, rows };
}

function PaymentsPrintContent() {
  const sp = useSearchParams();
  const month = sp.get("month") || "";
  const method = sp.get("method") || "";
  const status = sp.get("status") || "";
  const dFilter = sp.get("delivery") || ""; // not-delivered | partial | delivered
  const [csv, setCsv] = useState<string>("");
  const [err, setErr] = useState<string>("");

  const url = useMemo(() => {
    const q = new URLSearchParams();
    if (month) q.set("month", month);
    if (method) q.set("method", method);
    if (status) q.set("status", status);
    if (dFilter) q.set("delivery", dFilter);
    return `/api/admin/payments/export?${q.toString()}`;
  }, [month, method, status, dFilter]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load CSV");
        const text = await res.text();
        if (active) setCsv(text);
        setTimeout(() => window.print(), 100);
      } catch (e: unknown) {
        if (active) {
          const message =
            e instanceof Error ? e.message : "Failed to load CSV";
          setErr(message);
        }
      }
    })();
    return () => { active = false; };
  }, [url]);

  const parsed = useMemo(() => (csv ? parseCSV(csv) : { header: [], rows: [] as string[][] }), [csv]);

  const amountIndex = useMemo(() => parsed.header.findIndex((h) => h.toLowerCase() === "amount"), [parsed]);
  const total = useMemo(() => {
    if (amountIndex < 0) return 0;
    return parsed.rows.reduce((s, r) => s + (parseFloat(r[amountIndex] || "0") || 0), 0);
  }, [parsed, amountIndex]);

  return (
    <section className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Payments Export {month ? `(${month})` : ""}</h1>
      <div className="text-sm text-muted-foreground mb-2">
        {method && <span className="mr-2">Method: {method}</span>}
        {status && <span className="mr-2">Status: {status}</span>}
        {dFilter && <span>Delivery: {dFilter}</span>}
      </div>
      {err && <p className="text-red-600">{err}</p>}
      {!err && (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr>
              {parsed.header.map((h, i) => (
                <th key={i} className="border px-2 py-1 text-left">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {parsed.rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j} className="border px-2 py-1 align-top">{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
          {amountIndex >= 0 && (
            <tfoot>
              <tr>
                <td className="border px-2 py-1 font-semibold">TOTAL</td>
                {parsed.header.slice(1, amountIndex).map((_, i) => (
                  <td key={i} className="border px-2 py-1"></td>
                ))}
                <td className="border px-2 py-1 font-semibold">{total.toFixed(2)}</td>
                {parsed.header.slice(amountIndex + 1).map((_, i) => (
                  <td key={i} className="border px-2 py-1"></td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      )}
      <style>{`@media print { body { -webkit-print-color-adjust: exact; } }`}</style>
    </section>
  );
}

export default function PaymentsPrintPage() {
  return (
    <Suspense
      fallback={
        <section className="p-6">
          <h1 className="text-2xl font-semibold mb-4">Payments Export</h1>
          <p className="text-sm text-muted-foreground">Loading export…</p>
        </section>
      }
    >
      <PaymentsPrintContent />
    </Suspense>
  );
}
