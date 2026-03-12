import { prisma } from "@/lib/prisma";
import type { ProcurementRequestSnapshot } from "@/lib/b2b-procurement-notifications";

type ReorderTemplateSnapshot = {
  id: string;
  customerId: string;
  name: string;
  notes: string | null;
  itemsText: string;
  cadence: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "CUSTOM";
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProcurementDraftLine = {
  raw: string;
  itemRef: string;
  quantity: number;
  productId: string | null;
  productName: string | null;
  matchedBy: "sku" | "name" | "fuzzy" | null;
};

export type ProcurementOrderDraft = {
  requestId: string;
  customerId: string;
  status: ProcurementRequestSnapshot["status"];
  clinicName: string;
  contactName: string;
  itemsSource: "request" | "template" | "none";
  lines: ProcurementDraftLine[];
  matchedCount: number;
  unmatchedCount: number;
  canPrefill: boolean;
};

function parseSnapshot<T>(meta: string | null) {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as { snapshot?: T };
    return parsed.snapshot ?? null;
  } catch {
    return null;
  }
}

function parseItemsText(value: string) {
  const rows: Array<{ raw: string; itemRef: string; quantity: number }> = [];
  const lines = value.split(/\r?\n/);
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    const cleaned = raw.replace(/^[\-\*\u2022]\s*/, "").trim();
    if (!cleaned) continue;

    const csv = cleaned.match(/^\s*([^,]+?)\s*,\s*([^,]*?)\s*,\s*(\d+(?:\.\d+)?)\s*$/);
    if (csv) {
      const itemRef = csv[1].trim();
      const qtyNum = Number(csv[3]);
      const quantity = Number.isFinite(qtyNum) && qtyNum > 0 ? Math.max(1, Math.round(qtyNum)) : 1;
      rows.push({ raw, itemRef: itemRef || cleaned, quantity });
      continue;
    }

    const match =
      cleaned.match(/^(.*?)[\s:,\-xX]+\s*(\d+(?:\.\d+)?)\s*(?:units?|pcs?|boxes?)?$/i) ||
      cleaned.match(/^(.*?)\s*\((\d+(?:\.\d+)?)\)$/);
    const itemRef = (match?.[1] || cleaned).trim();
    const qtyNum = Number(match?.[2] || 1);
    const quantity = Number.isFinite(qtyNum) && qtyNum > 0 ? Math.max(1, Math.round(qtyNum)) : 1;
    rows.push({ raw, itemRef, quantity });
  }
  return rows;
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function buildProcurementOrderDraft(requestId: string): Promise<ProcurementOrderDraft | null> {
  const last = await prisma.auditLog.findFirst({
    where: {
      entityType: "B2B_PROCUREMENT_REQUEST",
      entityId: requestId,
      action: {
        in: [
          "B2B_PROCUREMENT_REQUEST_CREATED",
          "B2B_PROCUREMENT_REQUEST_ASSIGNED",
          "B2B_PROCUREMENT_REQUEST_STATUS_UPDATED",
        ],
      },
    },
    orderBy: { createdAt: "desc" },
  });
  const snapshot = parseSnapshot<ProcurementRequestSnapshot>(last?.meta || null);
  if (!snapshot) return null;

  let sourceText = (snapshot.itemsText || "").trim();
  let itemsSource: "request" | "template" | "none" = "none";
  if (sourceText) {
    itemsSource = "request";
  } else if (snapshot.templateId) {
    const tplLast = await prisma.auditLog.findFirst({
      where: {
        entityType: "B2B_REORDER_TEMPLATE",
        entityId: snapshot.templateId,
        action: {
          in: [
            "B2B_REORDER_TEMPLATE_CREATED",
            "B2B_REORDER_TEMPLATE_UPDATED",
          ],
        },
      },
      orderBy: { createdAt: "desc" },
    });
    const tpl = parseSnapshot<ReorderTemplateSnapshot>(tplLast?.meta || null);
    sourceText = (tpl?.itemsText || "").trim();
    if (sourceText) itemsSource = "template";
  }

  const parsedRows = sourceText ? parseItemsText(sourceText) : [];
  const products = await prisma.product.findMany({
    where: { deletedAt: null },
    select: { id: true, sku: true, name: true },
    take: 4000,
  });
  const bySku = new Map<string, { id: string; name: string }>();
  const byName = new Map<string, { id: string; name: string }>();
  for (const product of products) {
    if (product.sku) bySku.set(product.sku.trim().toLowerCase(), { id: product.id, name: product.name });
    byName.set(normalizeKey(product.name), { id: product.id, name: product.name });
  }

  const lines: ProcurementDraftLine[] = parsedRows.map((row) => {
    const skuHit = bySku.get(row.itemRef.toLowerCase());
    if (skuHit) {
      return {
        raw: row.raw,
        itemRef: row.itemRef,
        quantity: row.quantity,
        productId: skuHit.id,
        productName: skuHit.name,
        matchedBy: "sku",
      };
    }
    const exactName = byName.get(normalizeKey(row.itemRef));
    if (exactName) {
      return {
        raw: row.raw,
        itemRef: row.itemRef,
        quantity: row.quantity,
        productId: exactName.id,
        productName: exactName.name,
        matchedBy: "name",
      };
    }

    const refKey = normalizeKey(row.itemRef);
    const fuzzyMatches = products.filter((p) => {
      const productKey = normalizeKey(p.name);
      return productKey.includes(refKey) || refKey.includes(productKey);
    });
    if (fuzzyMatches.length === 1) {
      return {
        raw: row.raw,
        itemRef: row.itemRef,
        quantity: row.quantity,
        productId: fuzzyMatches[0].id,
        productName: fuzzyMatches[0].name,
        matchedBy: "fuzzy",
      };
    }

    return {
      raw: row.raw,
      itemRef: row.itemRef,
      quantity: row.quantity,
      productId: null,
      productName: null,
      matchedBy: null,
    };
  });

  const matchedCount = lines.filter((line) => !!line.productId).length;
  const unmatchedCount = lines.length - matchedCount;
  return {
    requestId: snapshot.id,
    customerId: snapshot.customerId,
    status: snapshot.status,
    clinicName: snapshot.clinicName,
    contactName: snapshot.contactName,
    itemsSource,
    lines,
    matchedCount,
    unmatchedCount,
    canPrefill: matchedCount > 0,
  };
}
