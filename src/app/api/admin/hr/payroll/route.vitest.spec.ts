import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockPayrollRunFindMany,
  mockPayrollRunFindFirst,
  mockPayrollRunCreate,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockPayrollRunFindMany: vi.fn(),
  mockPayrollRunFindFirst: vi.fn(),
  mockPayrollRunCreate: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: vi.fn() }));
vi.mock("@/lib/hr-payslip-utils", () => ({
  summarizeMissingBankDetails: vi.fn().mockReturnValue({ count: 0, entries: [] }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    payrollRun: {
      findMany: mockPayrollRunFindMany,
      findFirst: mockPayrollRunFindFirst,
      create: mockPayrollRunCreate,
    },
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { GET, POST } from "./route";

// ── Helpers ───────────────────────────────────────────────────────────────
const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN", email: "admin@example.com" } };
const ACCOUNTANT_SESSION = { user: { id: "u2", role: "ACCOUNTANT" } };
const STAFF_SESSION = { user: { id: "u3", role: "STAFF" } };

const VALID_PERIOD = {
  periodStart: "2026-03-01T00:00:00.000Z",
  periodEnd: "2026-03-31T23:59:59.000Z",
};

function makeGET(): Request {
  return new Request("http://localhost:3000/api/admin/hr/payroll", {
    method: "GET",
    headers: { origin: "http://localhost:3000" },
  });
}

function makePOST(body?: unknown): Request {
  return new Request("http://localhost:3000/api/admin/hr/payroll", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify(body ?? VALID_PERIOD),
  });
}

const mockRun = {
  id: "run-1",
  periodStart: new Date("2026-03-01"),
  periodEnd: new Date("2026-03-31"),
  status: "DRAFT",
  runType: "REGULAR",
  totalGross: 0,
  totalNet: 0,
  finalizedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertSameOrigin.mockReturnValue(true);
});

// ── GET – auth guard ───────────────────────────────────────────────────────

describe("GET /api/admin/hr/payroll – auth guard", () => {
  it("returns 401 when no session", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await GET(makeGET());
    expect(res.status).toBe(401);
  });

  it("returns 401 when role is STAFF", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    const res = await GET(makeGET());
    expect(res.status).toBe(401);
  });

  it("returns 401 when role is ACCOUNTANT", async () => {
    mockGetServerSession.mockResolvedValue(ACCOUNTANT_SESSION);
    const res = await GET(makeGET());
    expect(res.status).toBe(401);
  });

  it("returns 200 for ADMIN", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPayrollRunFindMany.mockResolvedValue([]);
    const res = await GET(makeGET());
    expect(res.status).toBe(200);
    expect((await res.json()).rows).toEqual([]);
  });
});

// ── POST – auth guard ──────────────────────────────────────────────────────

describe("POST /api/admin/hr/payroll – auth guard", () => {
  it("returns 401 when no session", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makePOST());
    expect(res.status).toBe(401);
  });

  it("returns 401 when role is ACCOUNTANT (not ADMIN)", async () => {
    mockGetServerSession.mockResolvedValue(ACCOUNTANT_SESSION);
    const res = await POST(makePOST());
    expect(res.status).toBe(401);
  });

  it("returns 401 when role is STAFF", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    const res = await POST(makePOST());
    expect(res.status).toBe(401);
  });
});

// ── POST – CSRF guard ──────────────────────────────────────────────────────

describe("POST /api/admin/hr/payroll – CSRF guard", () => {
  it("returns 403 when assertSameOrigin returns false", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await POST(makePOST());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Bad origin");
  });
});

// ── POST – body override guard ─────────────────────────────────────────────

describe("POST /api/admin/hr/payroll – body override guard", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("returns 400 when body contains status field", async () => {
    const res = await POST(makePOST({ ...VALID_PERIOD, status: "FINALIZED" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/manual status/i);
  });

  it("returns 400 when body contains totalGross field", async () => {
    const res = await POST(makePOST({ ...VALID_PERIOD, totalGross: 5000 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/manual status/i);
  });

  it("returns 400 when body contains totalNet field", async () => {
    const res = await POST(makePOST({ ...VALID_PERIOD, totalNet: 4000 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/manual status/i);
  });
});

// ── POST – input validation ────────────────────────────────────────────────

describe("POST /api/admin/hr/payroll – input validation", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("returns 400 when periodStart is missing", async () => {
    const res = await POST(makePOST({ periodEnd: VALID_PERIOD.periodEnd }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when periodEnd is missing", async () => {
    const res = await POST(makePOST({ periodStart: VALID_PERIOD.periodStart }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when periodStart is not a valid datetime string", async () => {
    const res = await POST(makePOST({ periodStart: "not-a-date", periodEnd: VALID_PERIOD.periodEnd }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when extra fields are present (strict schema)", async () => {
    const res = await POST(makePOST({ ...VALID_PERIOD, notes: "extra field" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });
});

// ── POST – business logic ──────────────────────────────────────────────────

describe("POST /api/admin/hr/payroll – business logic", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("returns 400 when periodEnd is earlier than periodStart", async () => {
    const res = await POST(makePOST({
      periodStart: "2026-03-31T00:00:00.000Z",
      periodEnd: "2026-03-01T00:00:00.000Z",
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/period end cannot be earlier/i);
  });

  it("returns 409 when an overlapping DRAFT run exists", async () => {
    mockPayrollRunFindFirst.mockResolvedValue({
      id: "run-existing",
      status: "DRAFT",
      periodStart: new Date("2026-03-01"),
      periodEnd: new Date("2026-03-31"),
    });
    const res = await POST(makePOST());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/draft payroll run already exists/i);
    expect(body.overlap.id).toBe("run-existing");
  });

  it("returns 409 when an overlapping FINALIZED run exists", async () => {
    mockPayrollRunFindFirst.mockResolvedValue({
      id: "run-finalized",
      status: "FINALIZED",
      periodStart: new Date("2026-03-01"),
      periodEnd: new Date("2026-03-31"),
    });
    const res = await POST(makePOST());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/finalized or paid/i);
  });
});

// ── POST – success ─────────────────────────────────────────────────────────

describe("POST /api/admin/hr/payroll – success", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPayrollRunFindFirst.mockResolvedValue(null); // no overlap
  });

  it("returns 200 with the created run object", async () => {
    mockPayrollRunCreate.mockResolvedValue(mockRun);
    const res = await POST(makePOST());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("run-1");
    expect(body.status).toBe("DRAFT");
  });

  it("creates run with DRAFT status and runType REGULAR", async () => {
    mockPayrollRunCreate.mockResolvedValue(mockRun);
    await POST(makePOST());
    expect(mockPayrollRunCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DRAFT", runType: "REGULAR" }),
      }),
    );
  });
});
