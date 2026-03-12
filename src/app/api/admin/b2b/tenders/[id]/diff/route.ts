import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type SnapshotLine = {
  no: number;
  requestedDescription: string;
  requestedUnit: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  matchedProductName?: string | null;
};

type SnapshotLite = {
  tenderNumber?: string;
  total?: number;
  subtotal?: number;
  vatRatePct?: number;
  discountAmount?: number;
  freightAmount?: number;
  handlingAmount?: number;
  validityDays?: number;
  paymentTerms?: string | null;
  notes?: string | null;
  lines?: SnapshotLine[];
};

function toNum(v: unknown) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function GET(
  req: Request,
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
  const url = new URL(req.url);
  const fromVersionNo = Number(url.searchParams.get("from") || 0);
  const toVersionNo = Number(url.searchParams.get("to") || 0);

  const versions = await prisma.tenderVersion.findMany({
    where: { tenderId: params.id },
    select: { id: true, versionNo: true, status: true, snapshot: true, createdAt: true },
    orderBy: { versionNo: "desc" },
    take: 200,
  });
  if (versions.length < 2) {
    return NextResponse.json({ error: "At least 2 versions are required to compare." }, { status: 400 });
  }

  const newest = versions[0];
  const previous = versions[1];
  const fromVersion = versions.find((v) => v.versionNo === fromVersionNo) || previous;
  const toVersion = versions.find((v) => v.versionNo === toVersionNo) || newest;
  if (!fromVersion || !toVersion) {
    return NextResponse.json({ error: "Selected versions not found." }, { status: 404 });
  }

  const fromSnap = (fromVersion.snapshot || {}) as SnapshotLite;
  const toSnap = (toVersion.snapshot || {}) as SnapshotLite;
  const fromLines = (fromSnap.lines || []).map((line) => ({
    no: Number(line.no),
    key: String(line.requestedDescription || "").trim().toLowerCase(),
    quantity: toNum(line.quantity),
    unitPrice: toNum(line.unitPrice),
    lineTotal: toNum(line.lineTotal),
    description: String(line.requestedDescription || ""),
  }));
  const toLines = (toSnap.lines || []).map((line) => ({
    no: Number(line.no),
    key: String(line.requestedDescription || "").trim().toLowerCase(),
    quantity: toNum(line.quantity),
    unitPrice: toNum(line.unitPrice),
    lineTotal: toNum(line.lineTotal),
    description: String(line.requestedDescription || ""),
  }));

  const fromByKey = new Map(fromLines.map((line) => [line.key || `line-${line.no}`, line]));
  const toByKey = new Map(toLines.map((line) => [line.key || `line-${line.no}`, line]));
  const lineChanges: Array<{
    item: string;
    fromQty: number;
    toQty: number;
    fromUnitPrice: number;
    toUnitPrice: number;
    fromLineTotal: number;
    toLineTotal: number;
    changeType: "ADDED" | "REMOVED" | "CHANGED";
  }> = [];

  for (const [key, fromLine] of fromByKey) {
    const toLine = toByKey.get(key);
    if (!toLine) {
      lineChanges.push({
        item: fromLine.description,
        fromQty: fromLine.quantity,
        toQty: 0,
        fromUnitPrice: fromLine.unitPrice,
        toUnitPrice: 0,
        fromLineTotal: fromLine.lineTotal,
        toLineTotal: 0,
        changeType: "REMOVED",
      });
      continue;
    }
    if (
      fromLine.quantity !== toLine.quantity ||
      fromLine.unitPrice !== toLine.unitPrice ||
      fromLine.lineTotal !== toLine.lineTotal
    ) {
      lineChanges.push({
        item: toLine.description || fromLine.description,
        fromQty: fromLine.quantity,
        toQty: toLine.quantity,
        fromUnitPrice: fromLine.unitPrice,
        toUnitPrice: toLine.unitPrice,
        fromLineTotal: fromLine.lineTotal,
        toLineTotal: toLine.lineTotal,
        changeType: "CHANGED",
      });
    }
  }
  for (const [key, toLine] of toByKey) {
    if (!fromByKey.has(key)) {
      lineChanges.push({
        item: toLine.description,
        fromQty: 0,
        toQty: toLine.quantity,
        fromUnitPrice: 0,
        toUnitPrice: toLine.unitPrice,
        fromLineTotal: 0,
        toLineTotal: toLine.lineTotal,
        changeType: "ADDED",
      });
    }
  }

  return NextResponse.json({
    tenderId: params.id,
    from: {
      versionNo: fromVersion.versionNo,
      createdAt: fromVersion.createdAt.toISOString(),
      status: fromVersion.status,
      subtotal: toNum(fromSnap.subtotal),
      total: toNum(fromSnap.total),
      vatRatePct: toNum(fromSnap.vatRatePct),
      validityDays: toNum(fromSnap.validityDays),
      paymentTerms: fromSnap.paymentTerms || "",
    },
    to: {
      versionNo: toVersion.versionNo,
      createdAt: toVersion.createdAt.toISOString(),
      status: toVersion.status,
      subtotal: toNum(toSnap.subtotal),
      total: toNum(toSnap.total),
      vatRatePct: toNum(toSnap.vatRatePct),
      validityDays: toNum(toSnap.validityDays),
      paymentTerms: toSnap.paymentTerms || "",
    },
    totalsDelta: {
      subtotal: toNum(toSnap.subtotal) - toNum(fromSnap.subtotal),
      total: toNum(toSnap.total) - toNum(fromSnap.total),
      discountAmount: toNum(toSnap.discountAmount) - toNum(fromSnap.discountAmount),
      freightAmount: toNum(toSnap.freightAmount) - toNum(fromSnap.freightAmount),
      handlingAmount: toNum(toSnap.handlingAmount) - toNum(fromSnap.handlingAmount),
    },
    lineChanges: lineChanges.slice(0, 500),
  });
}

