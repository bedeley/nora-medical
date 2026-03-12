import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import {
  sanitizeFreeText,
  sanitizeTenderItemsText,
  validateLineOverrideNos,
} from "@/lib/tender-sanitization";
import {
  buildTenderPreview,
  listLatestTenderSnapshots,
  mapTenderStatusFromUi,
  nextTenderNumber,
  type TenderSnapshot,
} from "@/lib/b2b-tender";

const createSchema = z.object({
  tenderId: z.string().optional(),
  status: z.enum(["DRAFT", "SUBMITTED", "SENT", "WON", "LOST", "EXPIRED", "CANCELLED"]).optional(),
  buyerName: z.string().min(2).max(180),
  buyerContact: z.string().max(120).optional(),
  buyerEmail: z.string().email().optional(),
  tenderRef: z.string().max(120).optional(),
  lotTitle: z.string().max(140).optional(),
  currency: z.string().max(10).optional(),
  validityDays: z.number().int().min(1).max(365).optional(),
  notes: z.string().max(4000).optional(),
  vatRatePct: z.number().min(0).max(100).optional(),
  discountAmount: z.number().min(0).max(1_000_000).optional(),
  freightAmount: z.number().min(0).max(1_000_000).optional(),
  handlingAmount: z.number().min(0).max(1_000_000).optional(),
  leadTimeDays: z.number().int().min(0).max(365).optional(),
  paymentTerms: z.string().max(1000).optional(),
  marginThresholdPct: z.number().min(0).max(100).optional(),
  itemsText: z.string().min(2).max(20000),
  lineOverrides: z
    .array(
      z.object({
        no: z.number().int().min(1),
        matchedProductId: z.string().min(1).optional(),
        bidDisposition: z.enum(["AVAILABLE", "SUBSTITUTE", "NO_BID"]).optional(),
        unitPrice: z.number().min(0).max(1_000_000).optional(),
        quantity: z.number().int().min(1).max(1_000_000).optional(),
        leadTimeDays: z.number().int().min(0).max(365).optional(),
        supplyNote: z.string().max(200).optional(),
      }),
    )
    .max(500)
    .optional(),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const items = await listLatestTenderSnapshots(100);
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-b2b-tender-create", 60_000, 30);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const payload = parsed.data;
  const sanitizedItems = sanitizeTenderItemsText(payload.itemsText);
  if (!sanitizedItems.text || sanitizedItems.lineCount === 0) {
    return NextResponse.json({ error: "No valid item lines found" }, { status: 400 });
  }
  const preview = await buildTenderPreview({
    itemsText: sanitizedItems.text,
    currency: payload.currency,
  });
  const overrideValidation = validateLineOverrideNos(
    (payload.lineOverrides || []).map((row) => row.no),
    preview.lines.length,
  );
  if (!overrideValidation.ok) {
    return NextResponse.json({ error: overrideValidation.error || "Invalid line overrides" }, { status: 400 });
  }
  const overrideMap = new Map(
    (payload.lineOverrides || []).map((row) => [row.no, row]),
  );
  const overrideProductIds = Array.from(
    new Set(
      (payload.lineOverrides || [])
        .map((row) => row.matchedProductId || null)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const overrideProducts = overrideProductIds.length
    ? await prisma.product.findMany({
        where: { id: { in: overrideProductIds }, deletedAt: null },
        select: { id: true, name: true, sku: true, stock: true, price: true, cost: true },
      })
    : [];
  const overrideProductById = new Map(overrideProducts.map((row) => [row.id, row]));

  const lines = preview.lines.map((line) => {
    const ov = overrideMap.get(line.no);
    if (!ov) return line;
    const overrideProduct = ov.matchedProductId ? overrideProductById.get(ov.matchedProductId) : null;
    const bidDisposition = ov.bidDisposition || line.bidDisposition || "AVAILABLE";
    const quantity = ov.quantity ?? line.quantity;
    let unitPrice = ov.unitPrice ?? (overrideProduct ? Number(overrideProduct.price || 0) : line.unitPrice);
    if (bidDisposition === "NO_BID") {
      unitPrice = 0;
    }
    const previousTags = String(line.note || "")
      .split(";")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .filter((tag) => !/^lead\s+\d+d$/i.test(tag))
      .filter((tag) => !/^\d+\s+available now,\s+\d+\s+in\s+\d+\s+days?$/i.test(tag))
      .filter((tag) => !/^manual product$/i.test(tag))
      .filter((tag) => !/^manual price\/qty$/i.test(tag));
    const manualTags: string[] = [];
    if (overrideProduct) manualTags.push("Manual product");
    if (ov.unitPrice != null || ov.quantity != null) manualTags.push("Manual price/qty");
    const mergedTags = Array.from(new Set([...previousTags, ...manualTags]));
    return {
      ...line,
      quantity,
      unitPrice,
      lineTotal: quantity * unitPrice,
      matchedProductId: overrideProduct?.id || line.matchedProductId,
      matchedProductName: overrideProduct?.name || line.matchedProductName,
      matchedSku: overrideProduct?.sku || line.matchedSku,
      availableStock: overrideProduct ? Number(overrideProduct.stock || 0) : line.availableStock,
      baseCost: overrideProduct ? Number(overrideProduct.cost || 0) : line.baseCost,
      marginPct:
        (() => {
          const cost = overrideProduct ? Number(overrideProduct.cost || 0) : line.baseCost ?? 0;
          if (bidDisposition === "NO_BID") return null;
          if (!cost || cost <= 0) return null;
          return ((unitPrice - cost) / cost) * 100;
        })(),
      matchConfidence: overrideProduct ? "HIGH" : line.matchConfidence,
      bidDisposition,
      note: mergedTags.length ? mergedTags.join("; ") : null,
    };
  });
  const defaultMinMargin = Number(process.env.DEFAULT_MIN_MARGIN_PCT || 0);
  const marginThresholdPct = Number.isFinite(payload.marginThresholdPct)
    ? Number(payload.marginThresholdPct)
    : Number.isFinite(defaultMinMargin)
      ? defaultMinMargin
      : 0;
  const marginViolations = lines
    .filter((line) => line.baseCost != null && line.baseCost > 0)
    .filter((line) => {
      const marginPct = ((line.unitPrice - Number(line.baseCost || 0)) / Number(line.baseCost || 1)) * 100;
      return marginPct < marginThresholdPct;
    })
    .map((line) => ({
      no: line.no,
      item: line.matchedProductName || line.requestedDescription,
      unitPrice: line.unitPrice,
      baseCost: line.baseCost,
      requiredMinPrice: Number(line.baseCost || 0) * (1 + marginThresholdPct / 100),
    }));
  if (marginViolations.length > 0) {
    return NextResponse.json(
      {
        error: `One or more lines are below minimum margin threshold (${marginThresholdPct}%).`,
        marginViolations,
      },
      { status: 400 },
    );
  }

  const oosViolations = lines
    .filter((line) => line.bidDisposition !== "NO_BID")
    .filter((line) => line.availableStock != null && Number(line.availableStock) < Number(line.quantity))
    .map((line) => {
      const ov = overrideMap.get(line.no);
      const stock = Math.max(0, Math.floor(Number(line.availableStock || 0)));
      const balance = Math.max(0, Number(line.quantity) - stock);
      const lead = ov?.leadTimeDays;
      const note = (ov?.supplyNote || "").trim();
      const hasSplitNote = note.includes(String(stock)) && note.includes(String(balance));
      if (lead == null || !hasSplitNote) {
        return {
          no: line.no,
          item: line.matchedProductName || line.requestedDescription,
          availableNow: stock,
          balance,
          error: "Out-of-stock line requires lead time and split supply note",
        };
      }
      return null;
    })
    .filter(Boolean);
  if (oosViolations.length > 0) {
    return NextResponse.json(
      {
        error: "Out-of-stock lines must include lead time and split supply note (available now and balance).",
        oosViolations,
      },
      { status: 400 },
    );
  }

  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const vatRatePct = Number(payload.vatRatePct || 0);
  const vatAmount = subtotal * (vatRatePct / 100);
  const freightAmount = Number(payload.freightAmount || 0);
  const handlingAmount = Number(payload.handlingAmount || 0);
  const discountAmount = Number(payload.discountAmount || 0);
  const grandTotal = Math.max(0, subtotal + vatAmount + freightAmount + handlingAmount - discountAmount);

  const now = new Date().toISOString();
  const nextStatus = mapTenderStatusFromUi(payload.status || "DRAFT");
  const nowDate = new Date();
  const tenderId = payload.tenderId?.trim() || null;

  let tenderNumber = nextTenderNumber();
  let id = `b2b-tender-${randomUUID()}`;
  let previousVersionNo = 0;
  if (tenderId) {
    const existing = await prisma.tender.findUnique({
      where: { id: tenderId },
      select: { id: true, tenderNumber: true, status: true, _count: { select: { versions: true } } },
    });
    if (!existing) return NextResponse.json({ error: "Tender not found" }, { status: 404 });
    if (existing.status !== "DRAFT") {
      return NextResponse.json(
        { error: `Only DRAFT tenders can be edited directly. Current status: ${existing.status}` },
        { status: 409 },
      );
    }
    id = existing.id;
    tenderNumber = existing.tenderNumber;
    previousVersionNo = existing._count.versions || 0;
  }

  const snapshot: TenderSnapshot = {
    id,
    tenderNumber,
    status: nextStatus,
    buyerName: sanitizeFreeText(payload.buyerName, 180),
    buyerContact: payload.buyerContact ? sanitizeFreeText(payload.buyerContact, 120) : null,
    buyerEmail: payload.buyerEmail?.trim() || null,
    tenderRef: payload.tenderRef ? sanitizeFreeText(payload.tenderRef, 120) : null,
    lotTitle: payload.lotTitle ? sanitizeFreeText(payload.lotTitle, 140) : null,
    currency: preview.currency,
    validityDays: payload.validityDays || 14,
    notes: payload.notes ? sanitizeFreeText(payload.notes, 4000) : null,
    vatRatePct,
    vatAmount,
    discountAmount,
    freightAmount,
    handlingAmount,
    leadTimeDays: payload.leadTimeDays ?? null,
    paymentTerms: payload.paymentTerms ? sanitizeFreeText(payload.paymentTerms, 1000) : null,
    marginThresholdPct,
    itemsText: sanitizedItems.text,
    lines,
    subtotal,
    total: grandTotal,
    preparedById: user?.id || null,
    sentAt: nextStatus === "SENT" ? now : null,
    createdAt: now,
    updatedAt: now,
  };

  if (tenderId) {
    await prisma.tender.update({
      where: { id },
      data: {
        status: nextStatus,
        buyerName: snapshot.buyerName,
        buyerContact: snapshot.buyerContact,
        buyerEmail: snapshot.buyerEmail,
        tenderRef: snapshot.tenderRef,
        lotTitle: snapshot.lotTitle,
        currency: snapshot.currency,
        validityDays: snapshot.validityDays,
        notes: snapshot.notes,
        vatRatePct: snapshot.vatRatePct,
        vatAmount: snapshot.vatAmount,
        discountAmount: snapshot.discountAmount,
        freightAmount: snapshot.freightAmount,
        handlingAmount: snapshot.handlingAmount,
        leadTimeDays: snapshot.leadTimeDays,
        paymentTerms: snapshot.paymentTerms,
        marginThresholdPct: snapshot.marginThresholdPct,
        itemsText: snapshot.itemsText,
        subtotal: snapshot.subtotal,
        total: snapshot.total,
        preparedById: snapshot.preparedById,
        sentAt: nextStatus === "SENT" ? nowDate : null,
        submittedAt: nextStatus === "SUBMITTED" ? nowDate : null,
        wonAt: nextStatus === "WON" ? nowDate : null,
        lostAt: nextStatus === "LOST" ? nowDate : null,
        expiredAt: nextStatus === "EXPIRED" ? nowDate : null,
        cancelledAt: nextStatus === "CANCELLED" ? nowDate : null,
        items: {
          deleteMany: {},
          create: lines.map((line) => ({
            lineNo: line.no,
            requestedDescription: line.requestedDescription,
            requestedUnit: line.requestedUnit,
            quantity: line.quantity,
            matchedProductId: line.matchedProductId,
            matchedProductName: line.matchedProductName,
            matchedSku: line.matchedSku,
            availableStock: line.availableStock,
            baseCost: line.baseCost,
            marginPct: line.marginPct,
            unitPrice: line.unitPrice,
            lineTotal: line.lineTotal,
            matchConfidence: line.matchConfidence,
            bidDisposition: line.bidDisposition,
            note: line.note,
            leadTimeDays: overrideMap.get(line.no)?.leadTimeDays ?? null,
            supplyNote: overrideMap.get(line.no)?.supplyNote?.trim() || null,
          })),
        },
      },
    });
  } else {
    await prisma.tender.create({
      data: {
        id,
        tenderNumber,
        status: nextStatus,
        buyerName: snapshot.buyerName,
        buyerContact: snapshot.buyerContact,
        buyerEmail: snapshot.buyerEmail,
        tenderRef: snapshot.tenderRef,
        lotTitle: snapshot.lotTitle,
        currency: snapshot.currency,
        validityDays: snapshot.validityDays,
        notes: snapshot.notes,
        vatRatePct: snapshot.vatRatePct,
        vatAmount: snapshot.vatAmount,
        discountAmount: snapshot.discountAmount,
        freightAmount: snapshot.freightAmount,
        handlingAmount: snapshot.handlingAmount,
        leadTimeDays: snapshot.leadTimeDays,
        paymentTerms: snapshot.paymentTerms,
        marginThresholdPct: snapshot.marginThresholdPct,
        itemsText: snapshot.itemsText,
        subtotal: snapshot.subtotal,
        total: snapshot.total,
        preparedById: snapshot.preparedById,
        sentAt: nextStatus === "SENT" ? nowDate : null,
        submittedAt: nextStatus === "SUBMITTED" ? nowDate : null,
        wonAt: nextStatus === "WON" ? nowDate : null,
        lostAt: nextStatus === "LOST" ? nowDate : null,
        expiredAt: nextStatus === "EXPIRED" ? nowDate : null,
        cancelledAt: nextStatus === "CANCELLED" ? nowDate : null,
        items: {
          create: lines.map((line) => ({
            lineNo: line.no,
            requestedDescription: line.requestedDescription,
            requestedUnit: line.requestedUnit,
            quantity: line.quantity,
            matchedProductId: line.matchedProductId,
            matchedProductName: line.matchedProductName,
            matchedSku: line.matchedSku,
            availableStock: line.availableStock,
            baseCost: line.baseCost,
            marginPct: line.marginPct,
            unitPrice: line.unitPrice,
            lineTotal: line.lineTotal,
            matchConfidence: line.matchConfidence,
            bidDisposition: line.bidDisposition,
            note: line.note,
            leadTimeDays: overrideMap.get(line.no)?.leadTimeDays ?? null,
            supplyNote: overrideMap.get(line.no)?.supplyNote?.trim() || null,
          })),
        },
      },
    });
  }

  await prisma.tenderVersion.create({
    data: {
      tenderId: id,
      versionNo: previousVersionNo + 1,
      status: nextStatus,
      snapshot: snapshot as unknown as object,
      changeNote: tenderId ? "Tender updated" : "Tender created",
      createdById: user?.id || null,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorId: user?.id || null,
      action: tenderId ? "B2B_TENDER_UPDATED" : "B2B_TENDER_SAVED",
      entityType: "B2B_TENDER",
      entityId: id,
      meta: JSON.stringify({
        snapshot,
        versionNo: previousVersionNo + 1,
      }),
    },
  });

  return NextResponse.json({ ok: true, tenderId: id, snapshot });
}
