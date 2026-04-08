import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockIsFeatureEnabled,
  mockFindClosedPeriod,
  mockAppSettingFindUnique,
  mockLedgerAccountFindMany,
  mockLedgerAccountUpsert,
  mockJournalEntryFindFirst,
  mockJournalEntryCreate,
  mockOrderFindUnique,
  mockPurchaseFindUnique,
  mockPaymentFindUnique,
  mockSupplierPaymentFindUnique,
  mockTaxCodeFindFirst,
} = vi.hoisted(() => ({
  mockIsFeatureEnabled: vi.fn(),
  mockFindClosedPeriod: vi.fn(),
  mockAppSettingFindUnique: vi.fn(),
  mockLedgerAccountFindMany: vi.fn(),
  mockLedgerAccountUpsert: vi.fn(),
  mockJournalEntryFindFirst: vi.fn(),
  mockJournalEntryCreate: vi.fn(),
  mockOrderFindUnique: vi.fn(),
  mockPurchaseFindUnique: vi.fn(),
  mockPaymentFindUnique: vi.fn(),
  mockSupplierPaymentFindUnique: vi.fn(),
  mockTaxCodeFindFirst: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("@/lib/features", () => ({ isFeatureEnabled: mockIsFeatureEnabled }));
vi.mock("@/lib/accounting-periods", () => ({ findClosedPeriod: mockFindClosedPeriod }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSetting: { findUnique: mockAppSettingFindUnique },
    ledgerAccount: { findMany: mockLedgerAccountFindMany, upsert: mockLedgerAccountUpsert },
    journalEntry: { findFirst: mockJournalEntryFindFirst, create: mockJournalEntryCreate },
    order: { findUnique: mockOrderFindUnique },
    purchase: { findUnique: mockPurchaseFindUnique },
    payment: { findUnique: mockPaymentFindUnique },
    supplierPayment: { findUnique: mockSupplierPaymentFindUnique },
    taxCode: { findFirst: mockTaxCodeFindFirst },
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import {
  postPurchaseEntry,
  postOrderEntry,
  postPaymentEntry,
  postSupplierPaymentEntry,
} from "./accounting-posting";

// ── Shared mock data ───────────────────────────────────────────────────────

// Standard ledger accounts covering all default codes used in these four functions
const LEDGER_ACCOUNTS = [
  { code: "1000", id: "acct-cash" },
  { code: "1010", id: "acct-bank" },
  { code: "1100", id: "acct-ar" },
  { code: "1200", id: "acct-inventory" },
  { code: "2000", id: "acct-ap" },
  { code: "2100", id: "acct-vat" },
  { code: "2200", id: "acct-store-credit" },
  { code: "4000", id: "acct-sales" },
  { code: "4010", id: "acct-sales-discount" },
  { code: "5000", id: "acct-cogs" },
];

const CREATED_ENTRY = { id: "entry-1", status: "POSTED" };

beforeEach(() => {
  vi.clearAllMocks();
  // Happy-path defaults — all ensureEntry preconditions pass
  mockIsFeatureEnabled.mockResolvedValue(true);
  mockFindClosedPeriod.mockResolvedValue(null);
  mockAppSettingFindUnique.mockResolvedValue(null); // use default codes
  // resolveAccounts checks map.size === codes.length, so we must only return
  // the accounts whose codes were actually requested (matching the findMany filter).
  mockLedgerAccountFindMany.mockImplementation(
    ({ where }: { where?: { code?: { in?: string[] } } }) => {
      const requested: string[] = where?.code?.in ?? [];
      return Promise.resolve(LEDGER_ACCOUNTS.filter((a) => requested.includes(a.code)));
    },
  );
  mockLedgerAccountUpsert.mockResolvedValue({});
  mockJournalEntryFindFirst.mockResolvedValue(null); // no existing duplicate
  mockJournalEntryCreate.mockResolvedValue(CREATED_ENTRY);
  mockTaxCodeFindFirst.mockResolvedValue(null);
});

// ═══════════════════════════════════════════════════════════════════════════
// postPurchaseEntry
// ═══════════════════════════════════════════════════════════════════════════

describe("postPurchaseEntry – null guards", () => {
  it("returns null when amount is 0", async () => {
    const result = await postPurchaseEntry({ purchaseId: "p-1", amount: 0, createdAt: new Date() });
    expect(result).toBeNull();
    expect(mockJournalEntryCreate).not.toHaveBeenCalled();
  });

  it("returns null when amount is negative", async () => {
    const result = await postPurchaseEntry({ purchaseId: "p-1", amount: -100, createdAt: new Date() });
    expect(result).toBeNull();
  });

  it("returns null when accounting feature is disabled", async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);
    const result = await postPurchaseEntry({ purchaseId: "p-1", amount: 500, createdAt: new Date() });
    expect(result).toBeNull();
    expect(mockJournalEntryCreate).not.toHaveBeenCalled();
  });

  it("returns null when a duplicate POSTED entry already exists for this purchaseId", async () => {
    mockPurchaseFindUnique.mockResolvedValue(null);
    mockJournalEntryFindFirst.mockResolvedValue({ id: "existing-entry" });
    const result = await postPurchaseEntry({ purchaseId: "p-1", amount: 500, createdAt: new Date() });
    expect(result).toBeNull();
    expect(mockJournalEntryCreate).not.toHaveBeenCalled();
  });

  it("returns null when entry date is in a closed period", async () => {
    mockPurchaseFindUnique.mockResolvedValue(null);
    mockFindClosedPeriod.mockResolvedValue({ id: "period-1", name: "Jan 2026" });
    const result = await postPurchaseEntry({ purchaseId: "p-1", amount: 500, createdAt: new Date() });
    expect(result).toBeNull();
  });
});

describe("postPurchaseEntry – success", () => {
  it("creates a POSTED journal entry and returns it", async () => {
    mockPurchaseFindUnique.mockResolvedValue({
      id: "p-1",
      quantity: 10,
      product: { name: "Gloves", sku: "SG-001" },
    });
    const result = await postPurchaseEntry({ purchaseId: "p-1", amount: 500, createdAt: new Date() });
    expect(result).toEqual(CREATED_ENTRY);
    expect(mockJournalEntryCreate).toHaveBeenCalledOnce();
  });

  it("creates DR Inventory / CR AP lines", async () => {
    mockPurchaseFindUnique.mockResolvedValue({ id: "p-1", quantity: 5, product: null });
    await postPurchaseEntry({ purchaseId: "p-1", amount: 250, createdAt: new Date() });
    const callArg = mockJournalEntryCreate.mock.calls[0][0];
    const lines = callArg.data.lines.create;
    const inventoryLine = lines.find((l: { accountId: string; debit: number }) => l.debit === 250);
    const apLine = lines.find((l: { accountId: string; credit: number }) => l.credit === 250);
    expect(inventoryLine?.accountId).toBe("acct-inventory");
    expect(apLine?.accountId).toBe("acct-ap");
  });

  it("works when purchase is not found in DB (uses fallback memo)", async () => {
    mockPurchaseFindUnique.mockResolvedValue(null);
    const result = await postPurchaseEntry({ purchaseId: "p-missing", amount: 100, createdAt: new Date() });
    expect(result).toEqual(CREATED_ENTRY);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// postOrderEntry
// ═══════════════════════════════════════════════════════════════════════════

const mockOrder = {
  id: "order-1",
  subtotal: 100,
  total: 115,
  taxAmount: 15,
  taxRate: 15,
  createdAt: new Date("2026-03-01"),
  items: [
    {
      quantity: 2,
      costAtSale: 20,
      product: { name: "Gloves", sku: "SG-001", cost: 20 },
    },
  ],
};

describe("postOrderEntry – null guards", () => {
  it("returns null when order is not found", async () => {
    mockOrderFindUnique.mockResolvedValue(null);
    const result = await postOrderEntry({ orderId: "order-1" });
    expect(result).toBeNull();
    expect(mockJournalEntryCreate).not.toHaveBeenCalled();
  });

  it("returns null when feature is disabled", async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);
    mockOrderFindUnique.mockResolvedValue(mockOrder);
    const result = await postOrderEntry({ orderId: "order-1" });
    expect(result).toBeNull();
  });
});

describe("postOrderEntry – success", () => {
  it("creates a POSTED journal entry for a basic order (no tax, no COGS)", async () => {
    const simpleOrder = {
      ...mockOrder,
      taxAmount: 0,
      taxRate: 0,
      total: 100,
      items: [],
    };
    mockOrderFindUnique.mockResolvedValue(simpleOrder);
    const result = await postOrderEntry({ orderId: "order-1" });
    expect(result).toEqual(CREATED_ENTRY);
    expect(mockJournalEntryCreate).toHaveBeenCalledOnce();
  });

  it("includes DR AR and CR SALES lines", async () => {
    const simpleOrder = { ...mockOrder, taxAmount: 0, taxRate: 0, total: 100, items: [] };
    mockOrderFindUnique.mockResolvedValue(simpleOrder);
    await postOrderEntry({ orderId: "order-1" });
    const lines = mockJournalEntryCreate.mock.calls[0][0].data.lines.create;
    expect(lines.some((l: { accountId: string; debit: number }) => l.accountId === "acct-ar" && l.debit > 0)).toBe(true);
    expect(lines.some((l: { accountId: string; credit: number }) => l.accountId === "acct-sales" && l.credit > 0)).toBe(true);
  });

  it("includes CR VAT_PAYABLE line when taxAmount > 0", async () => {
    mockOrderFindUnique.mockResolvedValue(mockOrder); // taxAmount: 15
    await postOrderEntry({ orderId: "order-1" });
    const lines = mockJournalEntryCreate.mock.calls[0][0].data.lines.create;
    expect(lines.some((l: { accountId: string; credit: number }) => l.accountId === "acct-vat" && l.credit === 15)).toBe(true);
  });

  it("includes DR COGS / CR Inventory lines when order has items with cost", async () => {
    mockOrderFindUnique.mockResolvedValue(mockOrder); // items with costAtSale: 20, qty: 2 → COGS = 40
    await postOrderEntry({ orderId: "order-1" });
    const lines = mockJournalEntryCreate.mock.calls[0][0].data.lines.create;
    expect(lines.some((l: { accountId: string; debit: number }) => l.accountId === "acct-cogs" && l.debit === 40)).toBe(true);
    expect(lines.some((l: { accountId: string; credit: number }) => l.accountId === "acct-inventory" && l.credit === 40)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// postPaymentEntry
// ═══════════════════════════════════════════════════════════════════════════

const mockCashPayment = {
  id: "pay-1",
  amount: 200,
  status: "PAID",
  note: null,
  orderId: "order-1",
  refundDisposition: null,
  createdAt: new Date("2026-03-01"),
  order: { invoiceNumber: "INV-001", receiptHash: null },
};

describe("postPaymentEntry – null guards", () => {
  it("returns null when payment is not found", async () => {
    mockPaymentFindUnique.mockResolvedValue(null);
    const result = await postPaymentEntry({ paymentId: "pay-1" });
    expect(result).toBeNull();
  });

  it("returns null when amount is 0", async () => {
    mockPaymentFindUnique.mockResolvedValue({ ...mockCashPayment, amount: 0 });
    const result = await postPaymentEntry({ paymentId: "pay-1" });
    expect(result).toBeNull();
  });

  it("returns null when payment status is REFUND", async () => {
    mockPaymentFindUnique.mockResolvedValue({ ...mockCashPayment, status: "REFUND" });
    const result = await postPaymentEntry({ paymentId: "pay-1" });
    expect(result).toBeNull();
  });

  it("returns null when payment status is VOID", async () => {
    mockPaymentFindUnique.mockResolvedValue({ ...mockCashPayment, status: "VOID" });
    const result = await postPaymentEntry({ paymentId: "pay-1" });
    expect(result).toBeNull();
  });

  it("returns null when refundDisposition is CREDIT", async () => {
    mockPaymentFindUnique.mockResolvedValue({ ...mockCashPayment, refundDisposition: "CREDIT" });
    const result = await postPaymentEntry({ paymentId: "pay-1" });
    expect(result).toBeNull();
  });
});

describe("postPaymentEntry – simple cash payment", () => {
  it("creates a POSTED journal entry for a regular cash payment", async () => {
    mockPaymentFindUnique.mockResolvedValue(mockCashPayment);
    const result = await postPaymentEntry({ paymentId: "pay-1" });
    expect(result).toEqual(CREATED_ENTRY);
    expect(mockJournalEntryCreate).toHaveBeenCalledOnce();
  });

  it("creates DR Cash / CR AR lines for a cash payment with orderId", async () => {
    mockPaymentFindUnique.mockResolvedValue(mockCashPayment);
    await postPaymentEntry({ paymentId: "pay-1" });
    const lines = mockJournalEntryCreate.mock.calls[0][0].data.lines.create;
    expect(lines.some((l: { accountId: string; debit: number }) => l.accountId === "acct-cash" && l.debit === 200)).toBe(true);
    expect(lines.some((l: { accountId: string; credit: number }) => l.accountId === "acct-ar" && l.credit === 200)).toBe(true);
  });
});

describe("postPaymentEntry – AUTO_APPLY (store credit)", () => {
  it("creates DR Store Credit / CR AR for AUTO_APPLY reference", async () => {
    mockPaymentFindUnique.mockResolvedValue({
      ...mockCashPayment,
      note: JSON.stringify({ reference: "AUTO_APPLY" }),
    });
    const result = await postPaymentEntry({ paymentId: "pay-1" });
    expect(result).toEqual(CREATED_ENTRY);
    const lines = mockJournalEntryCreate.mock.calls[0][0].data.lines.create;
    expect(lines.some((l: { accountId: string; debit: number }) => l.accountId === "acct-store-credit" && l.debit === 200)).toBe(true);
    expect(lines.some((l: { accountId: string; credit: number }) => l.accountId === "acct-ar" && l.credit === 200)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// postSupplierPaymentEntry
// ═══════════════════════════════════════════════════════════════════════════

const mockSupplierPayment = {
  id: "sp-1",
  amount: 500,
  method: "cash",
  reference: null,
  status: "NORMAL",
  paidAt: new Date("2026-03-01"),
  createdAt: new Date("2026-03-01"),
  purchase: { id: "p-1", product: { name: "Gloves", sku: "SG-001" } },
  supplier: { name: "MedSupply Ltd" },
};

describe("postSupplierPaymentEntry – null guards", () => {
  it("returns null when payment is not found", async () => {
    mockSupplierPaymentFindUnique.mockResolvedValue(null);
    const result = await postSupplierPaymentEntry({ supplierPaymentId: "sp-1" });
    expect(result).toBeNull();
  });

  it("returns null when amount is 0", async () => {
    mockSupplierPaymentFindUnique.mockResolvedValue({ ...mockSupplierPayment, amount: 0 });
    const result = await postSupplierPaymentEntry({ supplierPaymentId: "sp-1" });
    expect(result).toBeNull();
  });

  it("returns null when status is not NORMAL (e.g. PENDING_APPROVAL)", async () => {
    mockSupplierPaymentFindUnique.mockResolvedValue({ ...mockSupplierPayment, status: "PENDING_APPROVAL" });
    const result = await postSupplierPaymentEntry({ supplierPaymentId: "sp-1" });
    expect(result).toBeNull();
  });

  it("returns null for credit_memo method", async () => {
    mockSupplierPaymentFindUnique.mockResolvedValue({ ...mockSupplierPayment, method: "credit_memo" });
    const result = await postSupplierPaymentEntry({ supplierPaymentId: "sp-1" });
    expect(result).toBeNull();
  });

  it("returns null for SUPPLIER_RETURN reference", async () => {
    mockSupplierPaymentFindUnique.mockResolvedValue({ ...mockSupplierPayment, reference: "SUPPLIER_RETURN" });
    const result = await postSupplierPaymentEntry({ supplierPaymentId: "sp-1" });
    expect(result).toBeNull();
  });
});

describe("postSupplierPaymentEntry – success", () => {
  it("creates a POSTED journal entry for a cash supplier payment", async () => {
    mockSupplierPaymentFindUnique.mockResolvedValue(mockSupplierPayment);
    const result = await postSupplierPaymentEntry({ supplierPaymentId: "sp-1" });
    expect(result).toEqual(CREATED_ENTRY);
    expect(mockJournalEntryCreate).toHaveBeenCalledOnce();
  });

  it("creates DR AP / CR Cash lines for a cash payment", async () => {
    mockSupplierPaymentFindUnique.mockResolvedValue(mockSupplierPayment); // method: cash
    await postSupplierPaymentEntry({ supplierPaymentId: "sp-1" });
    const lines = mockJournalEntryCreate.mock.calls[0][0].data.lines.create;
    expect(lines.some((l: { accountId: string; debit: number }) => l.accountId === "acct-ap" && l.debit === 500)).toBe(true);
    expect(lines.some((l: { accountId: string; credit: number }) => l.accountId === "acct-cash" && l.credit === 500)).toBe(true);
  });

  it("uses BANK account for bank transfer method", async () => {
    mockSupplierPaymentFindUnique.mockResolvedValue({ ...mockSupplierPayment, method: "bank" });
    await postSupplierPaymentEntry({ supplierPaymentId: "sp-1" });
    const lines = mockJournalEntryCreate.mock.calls[0][0].data.lines.create;
    expect(lines.some((l: { accountId: string; credit: number }) => l.accountId === "acct-bank" && l.credit === 500)).toBe(true);
  });

  it("uses BANK account for transfer method", async () => {
    mockSupplierPaymentFindUnique.mockResolvedValue({ ...mockSupplierPayment, method: "transfer" });
    await postSupplierPaymentEntry({ supplierPaymentId: "sp-1" });
    const lines = mockJournalEntryCreate.mock.calls[0][0].data.lines.create;
    expect(lines.some((l: { accountId: string; credit: number }) => l.accountId === "acct-bank" && l.credit === 500)).toBe(true);
  });
});
