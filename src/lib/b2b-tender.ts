import fs from "fs";
import path from "path";
import sharp from "sharp";
import { PDFDocument as PDFLibDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { prisma } from "@/lib/prisma";

export type TenderLine = {
  no: number;
  requestedDescription: string;
  requestedUnit: string;
  quantity: number;
  matchedProductId: string | null;
  matchedProductName: string | null;
  matchedSku: string | null;
  availableStock: number | null;
  baseCost: number | null;
  marginPct: number | null;
  unitPrice: number;
  lineTotal: number;
  matchConfidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  bidDisposition: "AVAILABLE" | "SUBSTITUTE" | "NO_BID";
  note: string | null;
};

export type TenderSnapshot = {
  id: string;
  tenderNumber: string;
  status: "DRAFT" | "SUBMITTED" | "SENT" | "WON" | "LOST" | "EXPIRED" | "CANCELLED";
  buyerName: string;
  buyerContact: string | null;
  buyerEmail: string | null;
  tenderRef: string | null;
  lotTitle: string | null;
  currency: string;
  validityDays: number;
  notes: string | null;
  vatRatePct: number;
  vatAmount: number;
  discountAmount: number;
  freightAmount: number;
  handlingAmount: number;
  leadTimeDays: number | null;
  paymentTerms: string | null;
  marginThresholdPct: number;
  itemsText: string;
  lines: TenderLine[];
  subtotal: number;
  total: number;
  preparedById: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TenderPreviewInput = {
  itemsText: string;
  currency?: string;
};

export type TenderPreview = {
  lines: TenderLine[];
  subtotal: number;
  total: number;
  matchedCount: number;
  unmatchedCount: number;
  currency: string;
};

type ProductLite = {
  id: string;
  sku: string | null;
  name: string;
  price: unknown;
  cost: unknown;
  stock: number;
};

function normalize(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function cleanUnit(value: string) {
  const x = value.trim().toUpperCase();
  return x || "PCS";
}

function scoreNameMatch(query: string, candidate: string) {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.includes(q) || q.includes(c)) return 0.85;
  const qTokens = new Set(q.split(" ").filter(Boolean));
  const cTokens = new Set(c.split(" ").filter(Boolean));
  let overlap = 0;
  qTokens.forEach((token) => {
    if (cTokens.has(token)) overlap += 1;
  });
  const denom = Math.max(qTokens.size, cTokens.size, 1);
  return overlap / denom;
}

export function parseTenderItemsText(itemsText: string) {
  const rows = itemsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed: Array<{ description: string; unit: string; quantity: number }> = [];

  for (const raw of rows) {
    const cleaned = raw.replace(/^[\-\*\u2022]\s*/, "").trim();
    if (!cleaned) continue;

    if (cleaned.includes(",") || cleaned.includes("\t")) {
      const sep = cleaned.includes("\t") ? "\t" : ",";
      const cols = cleaned.split(sep).map((c) => c.trim()).filter(Boolean);
      if (cols.length >= 2) {
        const description = cols[0];
        const unit = cleanUnit(cols[1] || "PCS");
        const qty = Number(cols[2] || 1);
        parsed.push({
          description,
          unit,
          quantity: Number.isFinite(qty) && qty > 0 ? Math.round(qty) : 1,
        });
        continue;
      }
    }

    const qtyMatch =
      cleaned.match(/^(.*?)[\s:,\-xX]+\s*(\d+(?:\.\d+)?)\s*(?:units?|pcs?|boxes?|pkt|ream)?$/i) ||
      cleaned.match(/^(.*?)\s*\((\d+(?:\.\d+)?)\)$/);
    if (qtyMatch) {
      const description = (qtyMatch[1] || "").trim();
      const qty = Number(qtyMatch[2] || 1);
      parsed.push({
        description: description || cleaned,
        unit: "PCS",
        quantity: Number.isFinite(qty) && qty > 0 ? Math.round(qty) : 1,
      });
      continue;
    }

    parsed.push({ description: cleaned, unit: "PCS", quantity: 1 });
  }

  return parsed;
}

async function getProducts() {
  return prisma.product.findMany({
    where: { deletedAt: null, archived: false },
    select: { id: true, sku: true, name: true, price: true, cost: true, stock: true },
    take: 5000,
  });
}

function matchProduct(inputDescription: string, products: ProductLite[]) {
  const queryNorm = normalize(inputDescription);
  const skuExact = products.find(
    (p) => p.sku && normalize(p.sku) === queryNorm,
  );
  if (skuExact) return { product: skuExact, confidence: "HIGH" as const, note: "Matched by SKU" };

  const nameExact = products.find((p) => normalize(p.name) === queryNorm);
  if (nameExact) return { product: nameExact, confidence: "HIGH" as const, note: "Matched by exact name" };

  const scored = products
    .map((p) => ({ product: p, score: scoreNameMatch(inputDescription, p.name) }))
    .filter((row) => row.score >= 0.4)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { product: null, confidence: "NONE" as const, note: "No catalog match" };
  }
  if (scored.length === 1 || scored[0].score - (scored[1]?.score || 0) > 0.2) {
    const confidence: "MEDIUM" | "LOW" = scored[0].score >= 0.8 ? "MEDIUM" : "LOW";
    return {
      product: scored[0].product,
      confidence,
      note: confidence === "MEDIUM" ? "Matched by close name" : "Low-confidence name match",
    };
  }
  return { product: null, confidence: "NONE" as const, note: "Ambiguous match, select manually" };
}

export async function buildTenderPreview(input: TenderPreviewInput): Promise<TenderPreview> {
  const currency = (input.currency || "EUR").trim().toUpperCase();
  const parsed = parseTenderItemsText(input.itemsText || "");
  const products = (await getProducts()) as ProductLite[];

  const lines: TenderLine[] = parsed.map((row, idx) => {
    const matched = matchProduct(row.description, products);
    const unitPrice = matched.product ? Number(matched.product.price || 0) : 0;
    const baseCost = matched.product ? Number(matched.product.cost || 0) : null;
    const marginPct =
      baseCost != null && baseCost > 0
        ? ((unitPrice - baseCost) / baseCost) * 100
        : null;
    const lineTotal = unitPrice * row.quantity;
    return {
      no: idx + 1,
      requestedDescription: row.description,
      requestedUnit: row.unit,
      quantity: row.quantity,
      matchedProductId: matched.product?.id || null,
      matchedProductName: matched.product?.name || null,
      matchedSku: matched.product?.sku || null,
      availableStock: matched.product ? Number(matched.product.stock || 0) : null,
      baseCost,
      marginPct,
      unitPrice,
      lineTotal,
      matchConfidence: matched.confidence,
      bidDisposition: "AVAILABLE",
      note: matched.note,
    };
  });

  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  return {
    lines,
    subtotal,
    total: subtotal,
    matchedCount: lines.filter((line) => !!line.matchedProductId).length,
    unmatchedCount: lines.filter((line) => !line.matchedProductId).length,
    currency,
  };
}

export function parseTenderSnapshot(meta: string | null) {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as { snapshot?: TenderSnapshot };
    return parsed.snapshot ?? null;
  } catch {
    return null;
  }
}

function mapDbTenderToSnapshot(row: {
  id: string;
  tenderNumber: string;
  status: string;
  buyerName: string;
  buyerContact: string | null;
  buyerEmail: string | null;
  tenderRef: string | null;
  lotTitle: string | null;
  currency: string;
  validityDays: number;
  notes: string | null;
  vatRatePct: unknown;
  vatAmount: unknown;
  discountAmount: unknown;
  freightAmount: unknown;
  handlingAmount: unknown;
  leadTimeDays: number | null;
  paymentTerms: string | null;
  marginThresholdPct: unknown;
  itemsText: string;
  subtotal: unknown;
  total: unknown;
  preparedById: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  items: Array<{
    lineNo: number;
    requestedDescription: string;
    requestedUnit: string;
    quantity: number;
    matchedProductId: string | null;
    matchedProductName: string | null;
    matchedSku: string | null;
    availableStock: number | null;
    baseCost: unknown;
    marginPct: unknown;
    unitPrice: unknown;
    lineTotal: unknown;
    matchConfidence: string;
    bidDisposition: string;
    note: string | null;
    leadTimeDays: number | null;
    supplyNote: string | null;
  }>;
}): TenderSnapshot {
  return {
    id: row.id,
    tenderNumber: row.tenderNumber,
    status: row.status as TenderSnapshot["status"],
    buyerName: row.buyerName,
    buyerContact: row.buyerContact,
    buyerEmail: row.buyerEmail,
    tenderRef: row.tenderRef,
    lotTitle: row.lotTitle,
    currency: row.currency,
    validityDays: row.validityDays,
    notes: row.notes,
    vatRatePct: Number(row.vatRatePct || 0),
    vatAmount: Number(row.vatAmount || 0),
    discountAmount: Number(row.discountAmount || 0),
    freightAmount: Number(row.freightAmount || 0),
    handlingAmount: Number(row.handlingAmount || 0),
    leadTimeDays: row.leadTimeDays,
    paymentTerms: row.paymentTerms,
    marginThresholdPct: Number(row.marginThresholdPct || 0),
    itemsText: row.itemsText,
    lines: row.items
      .slice()
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((line) => ({
        no: line.lineNo,
        requestedDescription: line.requestedDescription,
        requestedUnit: line.requestedUnit,
        quantity: line.quantity,
        matchedProductId: line.matchedProductId,
        matchedProductName: line.matchedProductName,
        matchedSku: line.matchedSku,
        availableStock: line.availableStock,
        baseCost: line.baseCost != null ? Number(line.baseCost) : null,
        marginPct: line.marginPct != null ? Number(line.marginPct) : null,
        unitPrice: Number(line.unitPrice || 0),
        lineTotal: Number(line.lineTotal || 0),
        matchConfidence: line.matchConfidence as TenderLine["matchConfidence"],
        bidDisposition: (line.bidDisposition as TenderLine["bidDisposition"]) || "AVAILABLE",
        note:
          [line.note, line.leadTimeDays != null ? `Lead ${line.leadTimeDays}d` : null, line.supplyNote]
            .filter(Boolean)
            .join("; ") || null,
      })),
    subtotal: Number(row.subtotal || 0),
    total: Number(row.total || 0),
    preparedById: row.preparedById,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getLatestTenderSnapshot(tenderId: string) {
  const tender = await prisma.tender.findUnique({
    where: { id: tenderId },
    include: {
      items: {
        select: {
          lineNo: true,
          requestedDescription: true,
          requestedUnit: true,
          quantity: true,
          matchedProductId: true,
          matchedProductName: true,
          matchedSku: true,
          availableStock: true,
          baseCost: true,
          marginPct: true,
          unitPrice: true,
          lineTotal: true,
          matchConfidence: true,
          bidDisposition: true,
          note: true,
          leadTimeDays: true,
          supplyNote: true,
        },
      },
    },
  });
  if (!tender) return null;
  return mapDbTenderToSnapshot(tender);
}

export async function listLatestTenderSnapshots(limit = 100) {
  const tenders = await prisma.tender.findMany({
    where: { deletedAt: null },
    orderBy: { updatedAt: "desc" },
    include: {
      items: {
        select: {
          lineNo: true,
          requestedDescription: true,
          requestedUnit: true,
          quantity: true,
          matchedProductId: true,
          matchedProductName: true,
          matchedSku: true,
          availableStock: true,
          baseCost: true,
          marginPct: true,
          unitPrice: true,
          lineTotal: true,
          matchConfidence: true,
          bidDisposition: true,
          note: true,
          leadTimeDays: true,
          supplyNote: true,
        },
      },
    },
    take: limit,
  });
  return tenders.map((row) => mapDbTenderToSnapshot(row));
}

export function nextTenderNumber(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `TND-${y}${m}${d}-${rand}`;
}

export function mapTenderStatusFromUi(status: string): TenderSnapshot["status"] {
  const up = String(status || "DRAFT").toUpperCase();
  if (up === "SUBMITTED") return "SUBMITTED";
  if (up === "SENT") return "SENT";
  if (up === "WON") return "WON";
  if (up === "LOST") return "LOST";
  if (up === "EXPIRED") return "EXPIRED";
  if (up === "CANCELLED") return "CANCELLED";
  return "DRAFT";
}

export async function generateTenderPdf(snapshot: TenderSnapshot) {
  const safeText = (value: string | null | undefined) =>
    String(value || "")
      .normalize("NFKD")
      .replace(/[^\x20-\x7E]/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

  const pdfDoc = await PDFLibDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const width = 595.28;
  const height = 841.89;
  const margin = 36;
  const contentWidth = width - margin * 2;

  const logoPath = path.join(process.cwd(), "public", "logo.svg");
  let logo: Awaited<ReturnType<typeof pdfDoc.embedPng>> | null = null;
  if (fs.existsSync(logoPath)) {
    const svg = fs.readFileSync(logoPath);
    const png = await sharp(svg).png().toBuffer();
    logo = await pdfDoc.embedPng(png);
  }

  const pages: Array<{ page: ReturnType<typeof pdfDoc.addPage>; y: number }> = [];
  const palette = {
    navy: rgb(0.06, 0.17, 0.32),
    green: rgb(0.0, 0.52, 0.25),
    lime: rgb(0.49, 0.76, 0.26),
    blue: rgb(0.38, 0.71, 0.9),
    text: rgb(0.15, 0.15, 0.15),
    muted: rgb(0.45, 0.45, 0.45),
    border: rgb(0.82, 0.85, 0.89),
    panel: rgb(0.97, 0.98, 0.99),
    tableHeader: rgb(0.92, 0.95, 0.98),
  };
  const toMoney = (n: number) => n.toFixed(2);
  const tenderDate = new Date(snapshot.createdAt).toISOString().slice(0, 10);
  const currency = safeText(snapshot.currency || "EUR");
  const pageCols = { no: 44, desc: 76, unit: 332, qtyR: 405, unitPriceR: 494, totalR: 553 };
  const drawRightText = (
    page: ReturnType<typeof pdfDoc.addPage>,
    text: string,
    xRight: number,
    y: number,
    size: number,
    useBold = false,
    color = rgb(0.1, 0.1, 0.1),
  ) => {
    const f = useBold ? bold : font;
    const w = f.widthOfTextAtSize(text, size);
    page.drawText(text, { x: xRight - w, y, size, font: f, color });
  };
  const wrapText = (value: string, maxWidth: number, size: number) => {
    const cleaned = safeText(value);
    if (!cleaned) return ["-"];
    const words = cleaned.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = "";

    const pushCurrent = () => {
      if (current.trim()) lines.push(current.trim());
      current = "";
    };

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) pushCurrent();
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        current = word;
        continue;
      }

      let chunk = "";
      for (const ch of word) {
        const chunkCandidate = `${chunk}${ch}`;
        if (font.widthOfTextAtSize(chunkCandidate, size) <= maxWidth) {
          chunk = chunkCandidate;
          continue;
        }
        if (chunk) lines.push(chunk);
        chunk = ch;
      }
      current = chunk;
    }
    if (current) pushCurrent();
    return lines.length ? lines : ["-"];
  };
  const drawTableHeader = (page: ReturnType<typeof pdfDoc.addPage>, y: number) => {
    page.drawRectangle({
      x: margin,
      y: y - 4,
      width: contentWidth,
      height: 18,
      color: palette.tableHeader,
      borderColor: palette.border,
      borderWidth: 0.8,
    });
    page.drawText("NO", { x: pageCols.no, y, size: 8.5, font: bold, color: palette.navy });
    page.drawText("ITEM DESCRIPTION", { x: pageCols.desc, y, size: 8.5, font: bold, color: palette.navy });
    page.drawText("UNIT", { x: pageCols.unit, y, size: 8.5, font: bold, color: palette.navy });
    drawRightText(page, "QTY", pageCols.qtyR, y, 8.5, true, palette.navy);
    drawRightText(page, `UNIT PRICE (${currency})`, pageCols.unitPriceR, y, 8.5, true, palette.navy);
    drawRightText(page, `TOTAL (${currency})`, pageCols.totalR, y, 8.5, true, palette.navy);
    page.drawLine({
      start: { x: margin, y: y - 6.5 },
      end: { x: width - margin, y: y - 6.5 },
      thickness: 1,
      color: palette.border,
    });
  };

  const createPage = () => {
    const page = pdfDoc.addPage([width, height]);
    let y = height - margin;

    if (logo) {
      const natural = logo.scale(1);
      const targetWidth = Math.min(165, natural.width);
      const ratio = targetWidth / natural.width;
      page.drawImage(logo, {
        x: margin,
        y: height - 96,
        width: targetWidth,
        height: natural.height * ratio,
      });
    }

    page.drawRectangle({ x: 230, y: height - 45, width: 330, height: 9, color: palette.green });
    page.drawRectangle({ x: 230, y: height - 57, width: 290, height: 6, color: palette.lime });
    page.drawRectangle({ x: 230, y: height - 66, width: 250, height: 4, color: palette.blue });

    page.drawText("Tender / Quotation", {
      x: margin,
      y: height - 128,
      size: 18,
      font: bold,
      color: palette.navy,
    });
    page.drawText("Prepared by Noralls Medical Supplies", {
      x: margin,
      y: height - 144,
      size: 9,
      font,
      color: palette.muted,
    });

    page.drawRectangle({
      x: 338,
      y: height - 152,
      width: width - 338 - margin,
      height: 54,
      color: palette.panel,
      borderColor: palette.border,
      borderWidth: 0.8,
    });
    page.drawText(`Tender No: ${safeText(snapshot.tenderNumber)}`, { x: 348, y: height - 116, size: 9, font: bold, color: palette.navy });
    page.drawText(`Date: ${tenderDate}`, { x: 348, y: height - 130, size: 8.5, font, color: palette.text });
    page.drawText(`Status: ${safeText(snapshot.status)} | ${currency}`, { x: 348, y: height - 143, size: 8.5, font, color: palette.text });

    page.drawText("NORALLS MEDICAL SUPPLIES", {
      x: 44,
      y: 365,
      size: 44,
      font: bold,
      color: rgb(0.84, 0.88, 0.93),
      rotate: degrees(-33),
      opacity: 0.22,
    });

    page.drawRectangle({ x: margin, y: height - 244, width: 285, height: 78, borderColor: palette.border, borderWidth: 1 });
    page.drawText(`Buyer: ${safeText(snapshot.buyerName)}`, { x: margin + 10, y: height - 183, size: 9, font, color: palette.text });
    page.drawText(`Contact: ${safeText(snapshot.buyerContact || "-")}`, { x: margin + 10, y: height - 197, size: 9, font, color: palette.text });
    page.drawText(`Email: ${safeText(snapshot.buyerEmail || "-")}`, { x: margin + 10, y: height - 211, size: 9, font, color: palette.text });
    page.drawText(`Lot: ${safeText(snapshot.lotTitle || "-")}`, { x: margin + 10, y: height - 225, size: 9, font: bold, color: palette.navy });

    page.drawRectangle({
      x: 330,
      y: height - 244,
      width: width - 330 - margin,
      height: 78,
      borderColor: palette.border,
      borderWidth: 1,
    });
    page.drawText(`Tender Ref: ${safeText(snapshot.tenderRef || "-")}`, { x: 340, y: height - 183, size: 9, font, color: palette.text });
    page.drawText(`Validity: ${snapshot.validityDays} day(s)`, { x: 340, y: height - 197, size: 9, font, color: palette.text });
    page.drawText(`Lead Time: ${snapshot.leadTimeDays != null ? `${snapshot.leadTimeDays} day(s)` : "-"}`, { x: 340, y: height - 211, size: 9, font, color: palette.text });
    page.drawText(`Payment Terms: ${safeText(snapshot.paymentTerms || "-")}`, {
      x: 340,
      y: height - 225,
      size: 9,
      font,
      color: palette.text,
      maxWidth: width - 330 - margin - 10,
    });

    if (snapshot.notes) {
      page.drawText(`Notes: ${safeText(snapshot.notes)}`, {
        x: margin,
        y: height - 261,
        size: 8.5,
        font,
        color: palette.muted,
        maxWidth: contentWidth,
      });
    }

    y = height - 294;
    drawTableHeader(page, y);
    y -= 20;

    pages.push({ page, y });
    return pages[pages.length - 1];
  };

  let ctx = createPage();
  let rowIndex = 0;
  const rowFontSize = 8.5;
  const rowLineGap = 10;
  const rowBottomLimit = 168;

  for (const line of snapshot.lines) {
    const dispositionTag =
      line.bidDisposition === "NO_BID"
        ? "NO BID"
        : line.bidDisposition === "SUBSTITUTE"
          ? `SUBSTITUTED for ${safeText(line.requestedDescription)}`
          : "";
    const itemLabel = [
      safeText(line.matchedProductName || line.requestedDescription),
      dispositionTag ? `[${dispositionTag}]` : "",
      line.note ? `(${safeText(line.note)})` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const descLines = wrapText(itemLabel, 246, rowFontSize);
    const projectedRowBottom = ctx.y - (descLines.length - 1) * rowLineGap - 6;
    if (projectedRowBottom < rowBottomLimit) {
      ctx = createPage();
    }
    const rowTop = ctx.y + 9;
    const rowBottom = ctx.y - (descLines.length - 1) * rowLineGap - 6;
    const rowHeight = rowTop - rowBottom;

    if (rowIndex % 2 === 1) {
      ctx.page.drawRectangle({
        x: margin,
        y: rowBottom,
        width: contentWidth,
        height: rowHeight,
        color: rgb(0.985, 0.989, 0.994),
      });
    }
    ctx.page.drawText(String(line.no), { x: pageCols.no, y: ctx.y, size: rowFontSize, font, color: palette.text });
    for (let i = 0; i < descLines.length; i += 1) {
      ctx.page.drawText(descLines[i], {
        x: pageCols.desc,
        y: ctx.y - i * rowLineGap,
        size: rowFontSize,
        font,
        color: palette.text,
      });
    }
    ctx.page.drawText(safeText(line.requestedUnit || "PCS"), { x: pageCols.unit, y: ctx.y, size: rowFontSize, font, color: palette.text });
    drawRightText(ctx.page, String(line.quantity), pageCols.qtyR, ctx.y, rowFontSize, false, palette.text);
    drawRightText(ctx.page, toMoney(line.unitPrice), pageCols.unitPriceR, ctx.y, rowFontSize, false, palette.text);
    drawRightText(ctx.page, toMoney(line.lineTotal), pageCols.totalR, ctx.y, rowFontSize, false, palette.text);
    ctx.page.drawLine({
      start: { x: margin, y: rowBottom + 2 },
      end: { x: width - margin, y: rowBottom + 2 },
      thickness: 0.45,
      color: rgb(0.9, 0.92, 0.95),
    });
    ctx.y = rowBottom - 10;
    rowIndex += 1;
  }

  if (ctx.y < 250) ctx = createPage();
  ctx.page.drawRectangle({
    x: margin,
    y: ctx.y - 88,
    width: 295,
    height: 96,
    color: palette.panel,
    borderColor: palette.border,
    borderWidth: 1,
  });
  ctx.page.drawText("Commercial Terms", { x: margin + 10, y: ctx.y - 12, size: 10, font: bold, color: palette.navy });
  ctx.page.drawText(`Validity: ${snapshot.validityDays} day(s)`, { x: margin + 10, y: ctx.y - 28, size: 9, font, color: palette.text });
  ctx.page.drawText(`Lead time: ${snapshot.leadTimeDays != null ? `${snapshot.leadTimeDays} day(s)` : "-"}`, {
    x: margin + 10,
    y: ctx.y - 42,
    size: 9,
    font,
    color: palette.text,
  });
  ctx.page.drawText(`Payment terms: ${safeText(snapshot.paymentTerms || "-")}`, {
    x: margin + 10,
    y: ctx.y - 56,
    size: 9,
    font,
    color: palette.text,
    maxWidth: 278,
  });
  if (snapshot.notes) {
    ctx.page.drawText(`Notes: ${safeText(snapshot.notes)}`, {
      x: margin + 10,
      y: ctx.y - 72,
      size: 8,
      font,
      color: palette.muted,
      maxWidth: 278,
    });
  }

  ctx.page.drawRectangle({
    x: 360,
    y: ctx.y - 88,
    width: width - margin - 360,
    height: 96,
    color: palette.panel,
    borderColor: palette.border,
    borderWidth: 1,
  });
  ctx.y -= 14;
  const drawSummary = (label: string, value: string, isBold = false) => {
    const size = isBold ? 10.5 : 9;
    ctx.page.drawText(label, {
      x: 372,
      y: ctx.y,
      size,
      font: isBold ? bold : font,
      color: isBold ? palette.navy : palette.text,
    });
    drawRightText(
      ctx.page,
      value,
      width - margin - 8,
      ctx.y,
      size,
      isBold,
      isBold ? palette.navy : palette.text,
    );
    ctx.y -= isBold ? 16 : 14;
  };
  drawSummary("Subtotal", toMoney(snapshot.subtotal));
  drawSummary(`VAT (${snapshot.vatRatePct.toFixed(2)}%)`, toMoney(snapshot.vatAmount));
  drawSummary("Freight", toMoney(snapshot.freightAmount));
  drawSummary("Handling", toMoney(snapshot.handlingAmount));
  drawSummary("Discount", `-${toMoney(snapshot.discountAmount)}`);
  drawSummary("TOTAL", `${currency} ${toMoney(snapshot.total)}`, true);

  ctx.y -= 24;
  ctx.page.drawText("Authorized Signature", { x: margin, y: ctx.y, size: 9.5, font: bold, color: palette.navy });
  ctx.page.drawText("Client Acceptance", { x: 320, y: ctx.y, size: 9.5, font: bold, color: palette.navy });
  ctx.y -= 18;
  ctx.page.drawLine({ start: { x: margin, y: ctx.y }, end: { x: 230, y: ctx.y }, thickness: 1, color: rgb(0.35, 0.35, 0.35) });
  ctx.page.drawLine({ start: { x: 320, y: ctx.y }, end: { x: width - margin, y: ctx.y }, thickness: 1, color: rgb(0.35, 0.35, 0.35) });
  ctx.page.drawText("Name / Signature / Date", { x: margin, y: ctx.y - 12, size: 8, font, color: palette.muted });
  ctx.page.drawText("Name / Signature / Date", { x: 320, y: ctx.y - 12, size: 8, font, color: palette.muted });

  const totalPages = pages.length;
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i].page;
    page.drawLine({
      start: { x: margin, y: 40 },
      end: { x: width - margin, y: 40 },
      thickness: 0.6,
      color: palette.border,
    });
    page.drawText(
      "Prepared by Noralls Medical Supplies. Prices are subject to stock availability and tender terms.",
      { x: margin, y: 26, size: 8, font, color: palette.muted, maxWidth: contentWidth },
    );
    drawRightText(page, `Page ${i + 1} of ${totalPages}`, width - margin, 26, 8, false, palette.muted);
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}
