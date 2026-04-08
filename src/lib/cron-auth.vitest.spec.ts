import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { verifyCronSecret, verifyCronSecretAny, safeCompare } from "@/lib/cron-auth";

function makeRequest(authHeader = "", cronSecretHeader = "") {
  return {
    headers: {
      get(name: string) {
        if (name === "authorization") return authHeader || null;
        if (name === "x-cron-secret") return cronSecretHeader || null;
        return null;
      },
    },
  };
}

describe("safeCompare", () => {
  it("returns true for matching strings", () => {
    expect(safeCompare("secret123", "secret123")).toBe(true);
  });

  it("returns false for mismatched strings", () => {
    expect(safeCompare("secret123", "secret456")).toBe(false);
  });

  it("returns false when either is empty", () => {
    expect(safeCompare("", "secret")).toBe(false);
    expect(safeCompare("secret", "")).toBe(false);
    expect(safeCompare("", "")).toBe(false);
  });

  it("returns false when lengths differ (timing-safe)", () => {
    expect(safeCompare("short", "much-longer-string")).toBe(false);
  });
});

describe("verifyCronSecret", () => {
  const original = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret-value";
  });

  afterEach(() => {
    process.env.CRON_SECRET = original;
  });

  it("accepts valid Bearer token in Authorization header", () => {
    const req = makeRequest("Bearer test-cron-secret-value");
    expect(verifyCronSecret(req)).toBe(true);
  });

  it("accepts valid secret in x-cron-secret header", () => {
    const req = makeRequest("", "test-cron-secret-value");
    expect(verifyCronSecret(req)).toBe(true);
  });

  it("rejects wrong bearer token", () => {
    const req = makeRequest("Bearer wrong-secret");
    expect(verifyCronSecret(req)).toBe(false);
  });

  it("rejects missing token", () => {
    const req = makeRequest();
    expect(verifyCronSecret(req)).toBe(false);
  });

  it("rejects when CRON_SECRET env is not set", () => {
    delete process.env.CRON_SECRET;
    const req = makeRequest("Bearer test-cron-secret-value");
    expect(verifyCronSecret(req)).toBe(false);
  });

  it("uses fallback envKey when primary env is empty", () => {
    process.env.MY_CUSTOM_CRON_SECRET = "custom-secret-xyz";
    const req = makeRequest("Bearer custom-secret-xyz");
    expect(verifyCronSecret(req, "MY_CUSTOM_CRON_SECRET")).toBe(true);
    delete process.env.MY_CUSTOM_CRON_SECRET;
  });
});

describe("verifyCronSecretAny", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "global-cron-secret";
    process.env.HR_PAYROLL_CRON_SECRET = "hr-payroll-secret";
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.HR_PAYROLL_CRON_SECRET;
  });

  it("accepts the first matching key", () => {
    const req = makeRequest("Bearer global-cron-secret");
    expect(verifyCronSecretAny(req, ["CRON_SECRET", "HR_PAYROLL_CRON_SECRET"])).toBe(true);
  });

  it("accepts the second matching key", () => {
    const req = makeRequest("Bearer hr-payroll-secret");
    expect(verifyCronSecretAny(req, ["CRON_SECRET", "HR_PAYROLL_CRON_SECRET"])).toBe(true);
  });

  it("rejects if no key matches", () => {
    const req = makeRequest("Bearer totally-wrong");
    expect(verifyCronSecretAny(req, ["CRON_SECRET", "HR_PAYROLL_CRON_SECRET"])).toBe(false);
  });

  it("rejects empty token", () => {
    const req = makeRequest();
    expect(verifyCronSecretAny(req, ["CRON_SECRET"])).toBe(false);
  });
});
