import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockAssertSameOrigin,
  mockRateLimit,
  mockCheckOtpLockout,
  mockClearOtpFailures,
  mockRecordOtpFailure,
  mockBcryptCompare,
  mockUserOtpFindFirst,
  mockPrismaUserUpdate,
  mockPrismaUserOtpDelete,
  mockPrismaTransaction,
} = vi.hoisted(() => ({
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockCheckOtpLockout: vi.fn(),
  mockClearOtpFailures: vi.fn(),
  mockRecordOtpFailure: vi.fn(),
  mockBcryptCompare: vi.fn(),
  mockUserOtpFindFirst: vi.fn(),
  mockPrismaUserUpdate: vi.fn(),
  mockPrismaUserOtpDelete: vi.fn(),
  mockPrismaTransaction: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mockRateLimit,
  checkOtpLockout: mockCheckOtpLockout,
  clearOtpFailures: mockClearOtpFailures,
  recordOtpFailure: mockRecordOtpFailure,
}));
vi.mock("bcryptjs", () => ({ default: { compare: mockBcryptCompare } }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    userOtp: {
      findFirst: mockUserOtpFindFirst,
      delete: mockPrismaUserOtpDelete,
    },
    user: {
      update: mockPrismaUserUpdate,
    },
    $transaction: mockPrismaTransaction,
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { POST } from "./route";

// ── Helpers ───────────────────────────────────────────────────────────────
function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/register/verify", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const DEFAULT_OTP = { id: "otp-1", codeHash: "$2b$10$hashed", expiresAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
  mockCheckOtpLockout.mockResolvedValue({ locked: false });
  mockUserOtpFindFirst.mockResolvedValue(DEFAULT_OTP);
  mockBcryptCompare.mockResolvedValue(true);
  mockPrismaTransaction.mockResolvedValue([{}, {}]);
  mockClearOtpFailures.mockResolvedValue(undefined);
  mockRecordOtpFailure.mockResolvedValue(undefined);
});

// ── CSRF guard ─────────────────────────────────────────────────────────────

describe("POST /api/register/verify – CSRF guard", () => {
  it("returns 403 when assertSameOrigin returns false", async () => {
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await POST(makeRequest({ userId: "user-1", code: "123456" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Bad origin");
  });
});

// ── Rate limit ─────────────────────────────────────────────────────────────

describe("POST /api/register/verify – rate limit", () => {
  it("returns 429 when rate limit exceeded", async () => {
    mockRateLimit.mockResolvedValue({ ok: false });
    const res = await POST(makeRequest({ userId: "user-1", code: "123456" }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("Too many requests");
  });
});

// ── Input validation ───────────────────────────────────────────────────────

describe("POST /api/register/verify – input validation", () => {
  it("returns 400 when userId is missing", async () => {
    const res = await POST(makeRequest({ code: "123456" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("User and code are required");
  });

  it("returns 400 when code is missing", async () => {
    const res = await POST(makeRequest({ userId: "user-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("User and code are required");
  });
});

// ── OTP lockout ────────────────────────────────────────────────────────────

describe("POST /api/register/verify – OTP lockout", () => {
  it("returns 400 with 'Invalid or expired code' when account is locked", async () => {
    mockCheckOtpLockout.mockResolvedValue({ locked: true });
    const res = await POST(makeRequest({ userId: "user-1", code: "123456" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid or expired code");
  });
});

// ── OTP lookup ─────────────────────────────────────────────────────────────

describe("POST /api/register/verify – OTP lookup", () => {
  it("returns 400 with 'Code not found or expired' when no OTP record exists", async () => {
    mockUserOtpFindFirst.mockResolvedValue(null);
    const res = await POST(makeRequest({ userId: "user-1", code: "123456" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Code not found or expired");
  });
});

// ── OTP expiry ─────────────────────────────────────────────────────────────

describe("POST /api/register/verify – OTP expiry", () => {
  it("returns 400 with 'Code has expired' when OTP expiresAt is in the past", async () => {
    mockUserOtpFindFirst.mockResolvedValue({
      ...DEFAULT_OTP,
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await POST(makeRequest({ userId: "user-1", code: "123456" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Code has expired. Please register again.");
  });
});

// ── Code verification ──────────────────────────────────────────────────────

describe("POST /api/register/verify – code verification", () => {
  it("returns 400 and calls recordOtpFailure when bcrypt compare returns false", async () => {
    mockBcryptCompare.mockResolvedValue(false);
    const res = await POST(makeRequest({ userId: "user-1", code: "wrong" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid or expired code");
    expect(mockRecordOtpFailure).toHaveBeenCalledWith("phone_register", "user-1");
  });

  it("returns 200 with { ok: true } when code is valid", async () => {
    const res = await POST(makeRequest({ userId: "user-1", code: "123456" }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

// ── Success side effects ───────────────────────────────────────────────────

describe("POST /api/register/verify – success side effects", () => {
  it("calls clearOtpFailures with correct args on successful verification", async () => {
    const res = await POST(makeRequest({ userId: "user-1", code: "123456" }));
    expect(res.status).toBe(200);
    expect(mockClearOtpFailures).toHaveBeenCalledWith("phone_register", "user-1");
  });
});
