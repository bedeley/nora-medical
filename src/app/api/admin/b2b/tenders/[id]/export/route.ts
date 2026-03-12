import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createZip } from "@/lib/zip";
import { generateTenderPdf, getLatestTenderSnapshot } from "@/lib/b2b-tender";

function toCsvCell(value: string | number | null | undefined) {
  const raw = String(value ?? "");
  if (/[",\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const snapshot = await getLatestTenderSnapshot(params.id);
  if (!snapshot) return NextResponse.json({ error: "Tender not found" }, { status: 404 });

  const csvHeader = [
    "No",
    "Requested Description",
    "Unit",
    "Quantity",
    "Matched Product",
    "SKU",
    "Unit Price",
    "Line Total",
    "Bid Disposition",
    "Note",
  ];
  const csvRows = snapshot.lines.map((line) => [
    line.no,
    line.requestedDescription,
    line.requestedUnit,
    line.quantity,
    line.matchedProductName || "",
    line.matchedSku || "",
    line.unitPrice.toFixed(2),
    line.lineTotal.toFixed(2),
    line.bidDisposition || "AVAILABLE",
    line.note || "",
  ]);
  const csv = [csvHeader, ...csvRows]
    .map((row) => row.map((c) => toCsvCell(c)).join(","))
    .join("\n");

  const termsText = [
    `Tender Number: ${snapshot.tenderNumber}`,
    `Status: ${snapshot.status}`,
    `Buyer: ${snapshot.buyerName}`,
    `Buyer Contact: ${snapshot.buyerContact || "-"}`,
    `Buyer Email: ${snapshot.buyerEmail || "-"}`,
    `Tender Ref: ${snapshot.tenderRef || "-"}`,
    `Lot: ${snapshot.lotTitle || "-"}`,
    `Currency: ${snapshot.currency}`,
    `Validity Days: ${snapshot.validityDays}`,
    `Lead Time Days: ${snapshot.leadTimeDays ?? "-"}`,
    `Payment Terms: ${snapshot.paymentTerms || "-"}`,
    `Subtotal: ${snapshot.subtotal.toFixed(2)}`,
    `VAT Amount: ${snapshot.vatAmount.toFixed(2)}`,
    `Freight Amount: ${snapshot.freightAmount.toFixed(2)}`,
    `Handling Amount: ${snapshot.handlingAmount.toFixed(2)}`,
    `Discount Amount: ${snapshot.discountAmount.toFixed(2)}`,
    `Total: ${snapshot.total.toFixed(2)}`,
    "",
    "Notes / Terms:",
    snapshot.notes || "-",
  ].join("\n");

  const versions = await prisma.tenderVersion.findMany({
    where: { tenderId: snapshot.id },
    select: { versionNo: true, status: true, changeNote: true, createdAt: true },
    orderBy: { versionNo: "asc" },
    take: 300,
  });
  const versionCsv = [
    ["Version", "Status", "Change Note", "Created At"],
    ...versions.map((v) => [v.versionNo, v.status, v.changeNote || "", v.createdAt.toISOString()]),
  ]
    .map((row) => row.map((c) => toCsvCell(c)).join(","))
    .join("\n");

  const pdf = await generateTenderPdf(snapshot);
  const base = snapshot.tenderNumber.replace(/[^A-Za-z0-9._-]/g, "_");
  const zip = createZip([
    { name: `${base}.pdf`, data: pdf },
    { name: `${base}-lines.csv`, data: Buffer.from(csv, "utf8") },
    { name: `${base}-terms.txt`, data: Buffer.from(termsText, "utf8") },
    { name: `${base}-versions.csv`, data: Buffer.from(versionCsv, "utf8") },
    { name: `${base}-snapshot.json`, data: Buffer.from(JSON.stringify(snapshot, null, 2), "utf8") },
  ]);

  return new NextResponse(zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${base}-package.zip"`,
      "Cache-Control": "no-store",
    },
  });
}

