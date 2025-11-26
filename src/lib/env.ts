const rawStage =
  process.env.NEXT_PUBLIC_APP_STAGE ??
  process.env.APP_STAGE ??
  process.env.NODE_ENV ??
  "development";

export const APP_STAGE = rawStage.toLowerCase();

export const isLiveStage = () =>
  APP_STAGE === "production" || APP_STAGE === "prod" || APP_STAGE === "live";

const adminSessionMinutes = Number.parseInt(
  process.env.ADMIN_SESSION_MAX_AGE_MINUTES ?? "15",
  10
);

export const ADMIN_SESSION_MAX_AGE_SECONDS =
  Number.isFinite(adminSessionMinutes) && adminSessionMinutes > 0
    ? adminSessionMinutes * 60
    : 15 * 60;

