export type StaffProfileConflictCheck =
  | { ok: true }
  | { ok: false; status: 400 | 409; error: string };

export function validateExpectedUpdatedAt(
  existingUpdatedAt: Date,
  expectedUpdatedAt?: string | null,
): StaffProfileConflictCheck {
  const normalized = String(expectedUpdatedAt || "").trim();
  if (!normalized) return { ok: true };
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, status: 400, error: "Invalid expectedUpdatedAt value." };
  }
  if (existingUpdatedAt.getTime() !== parsed.getTime()) {
    return {
      ok: false,
      status: 409,
      error: "This record was changed by another admin. Refresh and try again.",
    };
  }
  return { ok: true };
}

export function validateStaffContactInput(params: { email: string; phone: string }) {
  const errors: Record<string, string> = {};
  const email = params.email.trim();
  const phone = params.phone.trim();

  if (email && !email.includes("@")) {
    errors.email = "Enter a valid email address.";
  }
  if (phone && phone.length < 5) {
    errors.phone = "Enter a valid phone number.";
  }
  return { email, phone, errors };
}

export function validateStaffBankInput(bank: {
  bankName: string;
  bankAccountName: string;
  bankAccountNumber: string;
  bankCode: string;
  bankBranch: string;
}) {
  const normalized = {
    bankName: bank.bankName.trim(),
    bankAccountName: bank.bankAccountName.trim(),
    bankAccountNumber: bank.bankAccountNumber.trim(),
    bankCode: bank.bankCode.trim(),
    bankBranch: bank.bankBranch.trim(),
  };
  const errors: Record<string, string> = {};
  if (!normalized.bankName) errors.bankName = "Bank name is required.";
  if (!normalized.bankAccountName) errors.bankAccountName = "Account name is required.";
  if (!normalized.bankAccountNumber) {
    errors.bankAccountNumber = "Account number is required.";
  } else if (!/^\d{6,20}$/.test(normalized.bankAccountNumber)) {
    errors.bankAccountNumber = "Account number must be 6 to 20 digits.";
  }
  if (normalized.bankCode && !/^[A-Za-z0-9-]{2,12}$/.test(normalized.bankCode)) {
    errors.bankCode = "Bank code must be 2 to 12 letters, digits, or hyphen.";
  }
  return { normalized, errors };
}

export function validateStaffDocumentFile(file: File | null) {
  if (!file) {
    return { ok: false as const, error: "Choose a document file." };
  }
  const maxBytes = 10 * 1024 * 1024;
  if (file.size > maxBytes) {
    return { ok: false as const, error: "File is too large. Maximum size is 10 MB." };
  }
  const allowed = new Set([
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/jpeg",
    "image/png",
    "image/webp",
  ]);
  if (!allowed.has(file.type)) {
    return { ok: false as const, error: "Unsupported file type. Use PDF, DOC, DOCX, JPG, PNG, or WEBP." };
  }
  return { ok: true as const };
}
