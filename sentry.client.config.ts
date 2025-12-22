import * as Sentry from "@sentry/nextjs";

const tracesSampleRate = process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
  ? Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE)
  : 0.1;
const replaysSessionSampleRate = process.env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE
  ? Number(process.env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE)
  : 0.1;
const replaysOnErrorSampleRate = process.env.NEXT_PUBLIC_SENTRY_REPLAY_ON_ERROR_SAMPLE_RATE
  ? Number(process.env.NEXT_PUBLIC_SENTRY_REPLAY_ON_ERROR_SAMPLE_RATE)
  : 1.0;

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  environment: process.env.NEXT_PUBLIC_APP_STAGE || process.env.NODE_ENV,
  tracesSampleRate,
  replaysSessionSampleRate,
  replaysOnErrorSampleRate,
  debug: false,
});
