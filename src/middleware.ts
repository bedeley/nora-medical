import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";
import type { NextRequestWithAuth } from "next-auth/middleware";
import { ADMIN_SESSION_MAX_AGE_SECONDS, isLiveStage } from "@/lib/env";

type AuthToken = {
  role?: string;
  mfaRequired?: boolean;
  adminExpiresAt?: number;
};

export default withAuth(
  function middleware(req: NextRequestWithAuth) {
    const { pathname } = req.nextUrl;
    const user = req.nextauth?.token as AuthToken | undefined;

    // Admin access control
    if (pathname.startsWith("/admin") && user?.role !== "ADMIN") {
      return NextResponse.redirect(new URL("/unauthorized", req.url));
    }

    // Enforce 2FA for admins when enabled
    if (pathname.startsWith("/admin")) {
      const mfaRequired = Boolean(user?.mfaRequired);
      if (mfaRequired) {
        const cookie = req.cookies.get("mfa")?.value;
        if (cookie !== "ok" && !pathname.startsWith("/admin/mfa")) {
          return NextResponse.redirect(new URL("/admin/mfa", req.url));
        }
      }
    }

    // Enforce strict admin session timeout in live stage
    if (pathname.startsWith("/admin") && isLiveStage() && user?.role === "ADMIN") {
      const now = Math.floor(Date.now() / 1000);
      const expiresAt =
        typeof user.adminExpiresAt === "number"
          ? user.adminExpiresAt
          : now + ADMIN_SESSION_MAX_AGE_SECONDS;

      if (expiresAt && now > expiresAt) {
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
      authorized: ({ token }) => {
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
  matcher: ["/admin/:path*"],
};
