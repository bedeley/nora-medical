import { describe, expect, it } from "vitest";
import { passwordSchema } from "@/lib/validation";

describe("passwordSchema", () => {
  it("rejects passwords shorter than 10 characters", () => {
    const result = passwordSchema.safeParse("Ab1!xyz");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain("10 characters");
  });

  it("rejects passwords with no uppercase letter", () => {
    const result = passwordSchema.safeParse("abcdefg1!xyz");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain("uppercase");
  });

  it("rejects passwords with no lowercase letter", () => {
    const result = passwordSchema.safeParse("ABCDEFG1!XYZ");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain("lowercase");
  });

  it("rejects passwords with no digit", () => {
    const result = passwordSchema.safeParse("Abcdefgh!xyz");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain("digit");
  });

  it("rejects passwords with no special character", () => {
    const result = passwordSchema.safeParse("Abcdefg1xyz2");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain("special character");
  });

  it("accepts a valid strong password", () => {
    const result = passwordSchema.safeParse("StrongPass1!");
    expect(result.success).toBe(true);
  });

  it("accepts a passphrase-style password", () => {
    const result = passwordSchema.safeParse("correct-Horse1-Battery");
    expect(result.success).toBe(true);
  });

  it("rejects blank string", () => {
    const result = passwordSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("rejects old 6-character passwords that used to pass", () => {
    // Previously the minimum was 6; ensure those are now rejected
    const result = passwordSchema.safeParse("Pass1!");
    expect(result.success).toBe(false);
  });
});
