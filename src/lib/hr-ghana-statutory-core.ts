export type GhanaPayeBand = {
  limit: number | null;
  rate: number;
};

export type GhanaStatutoryConfig = {
  autoStatutoryCalc: boolean;
  enablePaye: boolean;
  enableSsnitEmployee: boolean;
  enableSsnitEmployer: boolean;
  ssnitEmployeeRate: number;
  ssnitEmployerRate: number;
  taxableAllowancePercent: number;
  payeBands: GhanaPayeBand[];
};

const DEFAULT_AUTO_STATUTORY_CALC = true;
const DEFAULT_ENABLE_PAYE = true;
const DEFAULT_ENABLE_SSNIT_EMPLOYEE = true;
const DEFAULT_ENABLE_SSNIT_EMPLOYER = true;
const DEFAULT_SSNIT_EMPLOYEE_RATE = 5.5;
const DEFAULT_SSNIT_EMPLOYER_RATE = 13;
const DEFAULT_TAXABLE_ALLOWANCE_PERCENT = 100;
const DEFAULT_PAYE_BANDS: GhanaPayeBand[] = [
  { limit: 490, rate: 0 },
  { limit: 110, rate: 5 },
  { limit: 130, rate: 10 },
  { limit: 3166.67, rate: 17.5 },
  { limit: 16000, rate: 25 },
  { limit: 30520, rate: 30 },
  { limit: null, rate: 35 },
];

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

export function getDefaultGhanaStatutoryConfig(): GhanaStatutoryConfig {
  return {
    autoStatutoryCalc: DEFAULT_AUTO_STATUTORY_CALC,
    enablePaye: DEFAULT_ENABLE_PAYE,
    enableSsnitEmployee: DEFAULT_ENABLE_SSNIT_EMPLOYEE,
    enableSsnitEmployer: DEFAULT_ENABLE_SSNIT_EMPLOYER,
    ssnitEmployeeRate: DEFAULT_SSNIT_EMPLOYEE_RATE,
    ssnitEmployerRate: DEFAULT_SSNIT_EMPLOYER_RATE,
    taxableAllowancePercent: DEFAULT_TAXABLE_ALLOWANCE_PERCENT,
    payeBands: DEFAULT_PAYE_BANDS.map((band) => ({ ...band })),
  };
}

function sanitizeBands(input: unknown): GhanaPayeBand[] | null {
  if (!Array.isArray(input)) return null;
  const normalized = input
    .map((entry) => {
      const row = entry as { limit?: unknown; rate?: unknown };
      const rate = Number(row?.rate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) return null;
      if (row?.limit == null) return { limit: null, rate: round2(rate) } satisfies GhanaPayeBand;
      const limit = Number(row.limit);
      if (!Number.isFinite(limit) || limit <= 0) return null;
      return { limit: round2(limit), rate: round2(rate) } satisfies GhanaPayeBand;
    })
    .filter((row): row is GhanaPayeBand => Boolean(row));
  if (!normalized.length) return null;
  return normalized;
}

export function normalizeGhanaStatutoryConfig(input: {
  autoStatutoryCalc?: unknown;
  enablePaye?: unknown;
  enableSsnitEmployee?: unknown;
  enableSsnitEmployer?: unknown;
  ssnitEmployeeRate: unknown;
  ssnitEmployerRate?: unknown;
  taxableAllowancePercent?: unknown;
  payeBands: unknown;
}): GhanaStatutoryConfig {
  const defaults = getDefaultGhanaStatutoryConfig();
  const autoStatutoryCalc =
    typeof input.autoStatutoryCalc === "boolean"
      ? input.autoStatutoryCalc
      : defaults.autoStatutoryCalc;
  const enablePaye = typeof input.enablePaye === "boolean" ? input.enablePaye : defaults.enablePaye;
  const enableSsnitEmployee =
    typeof input.enableSsnitEmployee === "boolean"
      ? input.enableSsnitEmployee
      : defaults.enableSsnitEmployee;
  const enableSsnitEmployer =
    typeof input.enableSsnitEmployer === "boolean"
      ? input.enableSsnitEmployer
      : defaults.enableSsnitEmployer;
  const rawRate = Number(input.ssnitEmployeeRate);
  const ssnitEmployeeRate =
    Number.isFinite(rawRate) && rawRate >= 0 && rawRate <= 100
      ? round2(rawRate)
      : defaults.ssnitEmployeeRate;
  const rawEmployerRate = Number(input.ssnitEmployerRate);
  const ssnitEmployerRate =
    Number.isFinite(rawEmployerRate) && rawEmployerRate >= 0 && rawEmployerRate <= 100
      ? round2(rawEmployerRate)
      : defaults.ssnitEmployerRate;
  const rawTaxableAllowancePercent = Number(input.taxableAllowancePercent);
  const taxableAllowancePercent =
    Number.isFinite(rawTaxableAllowancePercent) &&
    rawTaxableAllowancePercent >= 0 &&
    rawTaxableAllowancePercent <= 100
      ? round2(rawTaxableAllowancePercent)
      : defaults.taxableAllowancePercent;
  const payeBands = sanitizeBands(input.payeBands) ?? defaults.payeBands;
  return {
    autoStatutoryCalc,
    enablePaye,
    enableSsnitEmployee,
    enableSsnitEmployer,
    ssnitEmployeeRate,
    ssnitEmployerRate,
    taxableAllowancePercent,
    payeBands,
  };
}

export function computeProgressiveTax(amount: number, bands: GhanaPayeBand[]) {
  if (!(amount > 0)) return 0;
  let remaining = amount;
  let totalTax = 0;
  for (const band of bands) {
    if (remaining <= 0) break;
    if (band.limit == null) {
      totalTax += remaining * (band.rate / 100);
      remaining = 0;
      break;
    }
    const taxable = Math.min(remaining, band.limit);
    totalTax += taxable * (band.rate / 100);
    remaining -= taxable;
  }
  return round2(totalTax);
}
