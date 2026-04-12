export type ProductSortField = "updatedAt" | "price" | "stock" | "name";

export type ProductSortDir = "asc" | "desc";

export type ProductStockFilter = "all" | "low" | "out";

export type ProductsSavedFilter = {
  id: string;
  name: string;
  state: {
    search: string;
    category: string;
    supplierId: string;
    includeArchived: boolean;
    sortField: ProductSortField;
    sortDir: ProductSortDir;
    showCost: boolean;
    stockFilter: ProductStockFilter;
    pageSize: number;
  };
};

export type SupplierOption = {
  id: string;
  name: string;
  leadTimeDays: number;
};

export type ProductsOverviewStats = {
  filteredTotal: number;
  outOfStockCount: number;
  lowStockCount: number;
  archivedCount: number;
  supplierCount: number;
  marginRiskCount: number | null;
};

export type AdminProduct = {
  id: string;
  sku?: string | null;
  name: string;
  description: string | null;
  imageUrl: string | null;
  category?: string | null;
  brand?: string | null;
  supplier?: string | null;
  supplierId?: string | null;
  approvalThresholdQty?: number | null;
  requiresLotTracking?: boolean | null;
  requiresExpiryDate?: boolean | null;
  minMarginPct?: number | null;
  price: number | string;
  cost: number | string;
  stock: number;
  archived?: boolean;
  orderCount?: number;
  createdAt: string | Date;
  updatedAt: string | Date;
};

export const SORT_OPTIONS: Array<{
  value: `${ProductSortField}-${ProductSortDir}`;
  label: string;
}> = [
  { value: "updatedAt-desc", label: "Recently updated" },
  { value: "updatedAt-asc", label: "Oldest updates" },
  { value: "name-asc", label: "Name A-Z" },
  { value: "name-desc", label: "Name Z-A" },
  { value: "price-desc", label: "Price high-low" },
  { value: "price-asc", label: "Price low-high" },
  { value: "stock-desc", label: "Stock high-low" },
  { value: "stock-asc", label: "Stock low-high" },
];

export const SYSTEM_SUPPLIER_NAMES = ["unknown", "initial stock", "initial order"] as const;
