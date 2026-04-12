export type AdminMovementDetailAuditPayload = {
  movementId: string;
  productId: string;
  productName: string;
  productSku?: string | null;
  reason: string;
  delta: number;
  createdAt: string;
  lotCode?: string | null;
  expiryDate?: string | null;
  supplier?: string | null;
  hasNote: boolean;
  hasUnitCost: boolean;
  filters: {
    start: string;
    end: string;
    product: string;
    reason: string;
    lotId: string;
  };
  page: number;
  pageSize: number;
  totalRows: number;
  sortBy: "createdAt" | "productName" | "delta" | "reason" | "expiryDate";
  sortDir: "asc" | "desc";
};

export async function logAdminMovementDetailView(payload: AdminMovementDetailAuditPayload) {
  try {
    await fetch("/api/admin/movements/detail-view", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Best effort only; never block movement detail access.
  }
}
