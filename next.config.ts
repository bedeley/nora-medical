import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";
import type { RemotePattern } from "next/dist/shared/lib/image-config";

const isProd = process.env.NODE_ENV === "production";

// Allow Next.js inline bootstrapping scripts; relax in prod to avoid blocking.
const scriptSrc = isProd
  ? "script-src 'self' 'unsafe-inline'"
  : "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:";

const r2PublicBase = process.env.R2_PUBLIC_BASE_URL;
let r2PublicHostname: string | null = null;
if (r2PublicBase) {
  try {
    r2PublicHostname = new URL(r2PublicBase).hostname;
  } catch {
    r2PublicHostname = null;
  }
}

const r2ExtraPatterns: RemotePattern[] = r2PublicHostname
  ? [{ protocol: "https", hostname: r2PublicHostname }]
  : [];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: {
    root: __dirname,
  },
  images: {
    dangerouslyAllowSVG: false,
    // Enable Next/Vercel image optimization; add domains/patterns as needed.
    unoptimized: false,
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "plus.unsplash.com" },
      { protocol: "https", hostname: "source.unsplash.com" },
      { protocol: "https", hostname: "pub-*.r2.dev" },
      { protocol: "https", hostname: "*.r2.cloudflarestorage.com" },
      ...r2ExtraPatterns,
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "geolocation=(), camera=(), microphone=()" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "img-src 'self' data: https:",
              scriptSrc,
              "style-src 'self' 'unsafe-inline'",
              "font-src 'self' data:",
              "connect-src 'self' https: wss:",
              "object-src 'none'",
              "frame-src 'none'",
              "frame-ancestors 'self'",
              "base-uri 'self'",
              "form-action 'self'",
              "upgrade-insecure-requests",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default withSentryConfig(
  nextConfig,
  {
    silent: true,
    disableLogger: true,
    sourcemaps: { disable: true },
  }
);
