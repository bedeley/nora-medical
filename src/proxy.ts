import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";
import type { NextRequestWithAuth } from "next-auth/middleware";
import { ADMIN_SESSION_MAX_AGE_SECONDS, isLiveStage } from "@/lib/env";
import { verifyMfaCookie } from "@/lib/mfa";

type AuthToken = {
  role?: string;
  mfaRequired?: boolean;
  adminExpiresAt?: number;
  sub?: string;
};

const ADMIN_ROLES = ["ADMIN", "STAFF", "ACCOUNTANT"] as const;
const API_ADMIN_PUBLIC_PATHS = new Set<string>([
  "/api/admin/users/invite/accept",
]);
const API_ADMIN_CRON_PREFIXES = [
  "/api/admin/health/alerts",
  "/api/admin/audit/retention",
  "/api/admin/hr/payroll/cron",
  "/api/admin/inventory-planning/recompute",
  "/api/admin/accounting/reports/scheduled/run",
  "/api/admin/accounting/journal/archive",
];

function isApiAdminPath(pathname: string) {
  return pathname.startsWith("/api/admin");
}

function isApiAdminPublicPath(pathname: string) {
  return API_ADMIN_PUBLIC_PATHS.has(pathname);
}

function isApiAdminCronPath(pathname: string) {
  return API_ADMIN_CRON_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function hasValidCronSecret(req: NextRequestWithAuth) {
  const authHeader = String((req.headers.get("authorization") || "").trim());
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const headerSecret = String((req.headers.get("x-cron-secret") || "").trim());
  const provided = bearer || headerSecret;
  if (!provided) return false;
  const cronSecret = String(process.env.CRON_SECRET || "").trim();
  const hrCronSecret = String(process.env.HR_PAYROLL_CRON_SECRET || "").trim();
  return (cronSecret && provided === cronSecret) || (hrCronSecret && provided === hrCronSecret);
}

export default withAuth(
  async function middleware(req: NextRequestWithAuth) {
    const { pathname } = req.nextUrl;
    const user = req.nextauth?.token as AuthToken | undefined;
    const isApiAdmin = isApiAdminPath(pathname);
    const isAdminPage = pathname.startsWith("/admin");

    if (isApiAdmin) {
      if (isApiAdminPublicPath(pathname)) {
        return NextResponse.next();
      }
      if (isApiAdminCronPath(pathname) && hasValidCronSecret(req)) {
        return NextResponse.next();
      }
    }

    // Admin access control
    if (
      (isAdminPage || isApiAdmin) &&
      !ADMIN_ROLES.includes(String(user?.role || "") as (typeof ADMIN_ROLES)[number])
    ) {
      if (isApiAdmin) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      return NextResponse.redirect(new URL("/unauthorized", req.url));
    }

    // Enforce 2FA for admins when enabled.
    if (isAdminPage || isApiAdmin) {
      const mfaRequired = Boolean(user?.mfaRequired);
      if (mfaRequired) {
        const cookie = req.cookies.get("mfa")?.value;
        const userId = user?.sub || "";
        const ok = cookie && userId ? await verifyMfaCookie(cookie, userId) : false;
        if (!ok && !(isAdminPage && pathname.startsWith("/admin/mfa"))) {
          if (isApiAdmin) {
            return NextResponse.json({ error: "MFA required" }, { status: 401 });
          }
          return NextResponse.redirect(new URL("/admin/mfa", req.url));
        }
      }
    }

    // Enforce strict admin session timeout in live stage
    if ((isAdminPage || isApiAdmin) && isLiveStage() && user?.role === "ADMIN") {
      const now = Math.floor(Date.now() / 1000);
      const expiresAt =
        typeof user.adminExpiresAt === "number"
          ? user.adminExpiresAt
          : now + ADMIN_SESSION_MAX_AGE_SECONDS;

      if (expiresAt && now > expiresAt) {
        if (isApiAdmin) {
          return NextResponse.json({ error: "Session expired" }, { status: 401 });
        }
        const url = new URL("/login", req.url);
        url.searchParams.set("reason", "session-expired");
        return NextResponse.redirect(url);
      }
    }

    return NextResponse.next();
  },
  {
    callbacks: {
      // Protect matched routes by requiring an authenticated, non-expired token
      authorized: ({ req, token }) => {
        const pathname = req.nextUrl.pathname;
        if (isApiAdminPath(pathname)) {
          if (isApiAdminPublicPath(pathname)) return true;
          if (isApiAdminCronPath(pathname) && hasValidCronSecret(req as NextRequestWithAuth)) {
            return true;
          }
          // Let middleware return API-friendly JSON 401/403 responses.
          return true;
        }
        if (!token) return false;
        const t = token as AuthToken;

        if (isLiveStage() && t.role === "ADMIN") {
          const now = Math.floor(Date.now() / 1000);
          if (t.adminExpiresAt && now > t.adminExpiresAt) {
            return false;
          }
        }

        return true;
      },
    },
  }
);

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
