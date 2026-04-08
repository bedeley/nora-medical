// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchAppSettingMock = vi.fn();
const saveAppSettingMock = vi.fn();

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { role: "ADMIN" } } }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/app-settings-client", () => ({
  fetchAppSetting: (key: string) => fetchAppSettingMock(key),
  saveAppSetting: (...args: unknown[]) => saveAppSettingMock(...args),
  fetchJsonOrThrow: async (res: { ok: boolean; json: () => Promise<unknown> }, fallbackError: string) => {
    const payload = await res.json();
    if (!res.ok) throw new Error(fallbackError);
    return payload;
  },
}));

import AccountingSettingsPage from "./page";

function createSnapshot<T>(key: string, value: T) {
  return {
    key,
    value,
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <AccountingSettingsPage />
    </QueryClientProvider>,
  );
}

describe("AccountingSettingsPage integrity thresholds", () => {
  beforeEach(() => {
    fetchAppSettingMock.mockReset();
    saveAppSettingMock.mockReset();
    saveAppSettingMock.mockResolvedValue({});

    fetchAppSettingMock.mockImplementation(async (key: string) => {
      switch (key) {
        case "accounting.integrity.thresholds":
          return createSnapshot(key, {
            arDifference: 0.01,
            inventoryDifference: 0.01,
            apDifference: 0.01,
            trialBalance: 0.01,
            revenueDifference: 0.01,
            vatDifference: 0.01,
            cogsDifference: 0.01,
            storeCreditDifference: 0.01,
            draftEntries: true,
            negativeStock: true,
          });
        case "accounting.reporting.useLedger":
          return createSnapshot(key, false);
        case "accounting.storeCredit.applyPolicy":
          return createSnapshot(key, "oldest_first");
        case "accounting.bankTransactions.editWindowDays":
          return createSnapshot(key, 7);
        case "accounting.manualEntries.policy":
          return createSnapshot(key, {
            periodBasis: "MONTHLY_CALENDAR",
            periodEndWindowDays: 5,
            requireExceptionOutsideWindow: true,
            minExceptionNoteLength: 12,
          });
        case "accounting.reconcile.thresholds":
          return createSnapshot(key, {
            currencyMinorPct: 0.01,
            currencyWarningPct: 0.05,
            marginMinorAbsPct: 0.1,
            marginWarningAbsPct: 0.5,
          });
        case "accounting.reopen.monthlyWindowDays":
          return createSnapshot(key, 7);
        case "accounting.reopen.fiscalWindowDays":
          return createSnapshot(key, 30);
        case "accounting.reopen.enforceFinalizedYearLock":
          return createSnapshot(key, false);
        case "accounting.reopen.finalizedFiscalYears":
          return createSnapshot(key, []);
        case "accounting.journal.policy":
          return createSnapshot(key, {
            recentWindowDays: 90,
            manualEntryAllowPnl: false,
            archiveAfterMonths: 18,
            archiveCronDryRun: false,
            largeAmountAnomalyThreshold: 25000,
          });
        default:
          return createSnapshot(key, null);
      }
    });

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl, "http://localhost");
      if (url.pathname === "/api/admin/audit") {
        return {
          ok: true,
          json: async () => ({ items: [] }),
        };
      }
      throw new Error(`Unhandled fetch in accounting settings test: ${url.pathname}${url.search}`);
    }));
  });

  it("renders the expanded integrity threshold fields and saves them in one payload", { timeout: 15000 }, async () => {
    const user = userEvent.setup();
    renderPage();

    const apInput = await screen.findByLabelText(/AP difference threshold \(GHS\)/i);
    const trialBalanceInput = screen.getByLabelText(/Trial balance delta threshold \(GHS\)/i);
    expect(apInput).toBeInTheDocument();
    expect(trialBalanceInput).toBeInTheDocument();
    expect(screen.getByLabelText(/Revenue difference threshold \(GHS\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/VAT difference threshold \(GHS\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/COGS difference threshold \(GHS\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Store-credit difference threshold \(GHS\)/i)).toBeInTheDocument();

    await user.clear(apInput);
    await user.type(apInput, "5");
    await user.clear(trialBalanceInput);
    await user.type(trialBalanceInput, "2.5");
    const expectedApDifference = Number((apInput as HTMLInputElement).value);
    const expectedTrialBalance = Number((trialBalanceInput as HTMLInputElement).value);

    fireEvent.click(screen.getByRole("button", { name: /save integrity thresholds/i }));

    await waitFor(() =>
      expect(saveAppSettingMock).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "accounting.integrity.thresholds",
          value: expect.objectContaining({
            arDifference: 0.01,
            inventoryDifference: 0.01,
            apDifference: expectedApDifference,
            trialBalance: expectedTrialBalance,
            revenueDifference: 0.01,
            vatDifference: 0.01,
            cogsDifference: 0.01,
            storeCreditDifference: 0.01,
            draftEntries: true,
            negativeStock: true,
          }),
        }),
        "Failed to save settings.",
      ),
    );
  });
});
