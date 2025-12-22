import * as Sentry from "@sentry/nextjs";

const tracesSampleRate = process.env.SENTRY_TRACES_SAMPLE_RATE
  ? Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
  : 0.1;

export function register() {
  if (!process.env.SENTRY_DSN) return;

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    enabled: Boolean(process.env.SENTRY_DSN),
    environment: process.env.APP_STAGE || process.env.NODE_ENV,
    tracesSampleRate,
    debug: false,
  });
}

export const onRequestError = Sentry.captureRequestError;
