import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockRecordAuditLog,
  mockBuildProcurementOrderDraft,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockRecordAuditLog: vi.fn(),
  mockBuildProcurementOrderDraft: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/b2b-procurement-draft", () => ({
  buildProcurementOrderDraft: mockBuildProcurementOrderDraft,
}));

import { POST } from "./route";

function makeRequest() {
  return new Request("http://localhost/api/admin/b2b/procurement/requests/req-1/draft-order", {
    method: "POST",
  });
}

function makeDraft(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    customerId: "cust-1",
    clinicName: "Korle Bu Clinic",
    status: "QUOTED",
    itemsSource: "request",
    matchedCount: 1,
    unmatchedCount: 0,
    canPrefill: true,
    lines: [{ rawText: "Gloves x 10", quantity: 10, productId: "prod-1" }],
    ...overrides,
  };
}

describe("POST /draft-order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", email: "admin@nora.gh", name: "Admin" },
    });
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
    mockRecordAuditLog.mockResolvedValue(undefined);
    mockBuildProcurementOrderDraft.mockResolvedValue(makeDraft());
  });

  it("records success audit metadata when a draft is prepared", async () => {
    const res = await POST(makeRequest(), { params: { id: "req-1" } });

    expect(res.status).toBe(200);
    const call = mockRecordAuditLog.mock.calls[0][0];
    expect(call.action).toBe("B2B_PROCUREMENT_REQUEST_DRAFT_ORDER_PREPARED");
    expect(call.outcome).toBe("SUCCESS");
    expect(call.meta.sourcePage).toBe("admin/b2b/procurement");
    expect(call.meta.matchedCount).toBe(1);
    expect(call.meta.unmatchedCount).toBe(0);
    expect(call.meta.actor.email).toBe("admin@nora.gh");
  });

  it("records failed audit metadata when status blocks draft preparation", async () => {
    mockBuildProcurementOrderDraft.mockResolvedValue(makeDraft({ status: "IN_REVIEW" }));

    const res = await POST(makeRequest(), { params: { id: "req-1" } });

    expect(res.status).toBe(400);
    const call = mockRecordAuditLog.mock.calls[0][0];
    expect(call.outcome).toBe("FAILED");
    expect(call.meta.requestStatus).toBe("IN_REVIEW");
    expect(call.meta.resultSummary).toMatch(/blocked/i);
  });
});
