import { PrismaAdapter } from "@auth/prisma-adapter";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import bcrypt from "bcrypt";
import type { AuthOptions } from "next-auth";
import type { JWT } from "next-auth/jwt";
import type { Role } from "@prisma/client";
import { ADMIN_SESSION_MAX_AGE_SECONDS, isLiveStage } from "@/lib/env";
import { decode as defaultJwtDecode, encode as defaultJwtEncode } from "next-auth/jwt";

export type AuthenticatedUser = {
  id: string;
  email: string | null;
  name: string | null;
  role: Role;
  twoFactorEnabled?: boolean | null;
  phoneVerifiedAt?: Date | null;
};

type ExtendedToken = JWT & {
  role?: Role;
  mfaRequired?: boolean;
  adminExpiresAt?: number;
  phoneVerified?: boolean;
};

/**
 * NextAuth configuration (v5-compatible)
 * - Uses Prisma Adapter for DB sessions
 * - Credentials login (email/password)
 * - Role-based session (USER / ADMIN)
 */
export const authOptions: AuthOptions = {
  adapter: PrismaAdapter(prisma),
  secret: process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET,

  session: {
    strategy: "jwt", // use JWT sessions instead of DB sessions
  },

  jwt: {
    encode: defaultJwtEncode,
    // Swallow decode errors (e.g., stale cookies after secret rotation) and treat as signed-out
    decode: async (params) => {
      try {
        return await defaultJwtDecode(params);
      } catch {
        console.warn("[auth] JWT decode failed; treating as unauthenticated");
        return null;
      }
    },
  },

  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        identifier: { label: "Email or username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const schema = z.object({
          identifier: z.string().min(3),
          password: z.string().min(6),
        });

        const parsed = schema.safeParse(credentials);
        if (!parsed.success) return null;

        const { identifier, password } = parsed.data;
        const raw = identifier.trim();
        const isEmail = raw.includes("@");

        const whereClause = isEmail
          ? { email: raw.toLowerCase() }
          : { username: raw.toLowerCase() };

        const user = await prisma.user.findUnique({
          where: whereClause,
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            password: true,
            twoFactorEnabled: true,
            phoneVerifiedAt: true,
          },
        });
        if (!user) {
          console.warn("[auth] login failed: user not found", { identifier: raw });
          return null;
        }

        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) {
          console.warn("[auth] login failed: bad password", { userId: user.id });
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          twoFactorEnabled: user.twoFactorEnabled ?? false,
        } satisfies AuthenticatedUser;
      },
    }),
  ],

  debug: process.env.NODE_ENV !== "production",
  logger: {
    error(code, metadata) {
      if (code === "JWT_SESSION_ERROR") return; // stale/invalid cookie; treat as signed out
      console.error("[auth:error]", code, metadata);
    },
    warn(code) {
      console.warn("[auth:warn]", code);
    },
    debug(code, metadata) {
      console.debug("[auth:debug]", code, metadata);
    },
  },

  callbacks: {
    async jwt({ token, user }) {
      const extendedToken = token as ExtendedToken;

      if (user) {
        const authUser = user as AuthenticatedUser;
        extendedToken.role = authUser.role;
        extendedToken.mfaRequired = authUser.role === "ADMIN" && Boolean(authUser.twoFactorEnabled);
        extendedToken.phoneVerified = Boolean(authUser.phoneVerifiedAt);

        if (isLiveStage() && authUser.role === "ADMIN") {
          const now = Math.floor(Date.now() / 1000);
          extendedToken.adminExpiresAt = now + ADMIN_SESSION_MAX_AGE_SECONDS;
        } else {
          extendedToken.adminExpiresAt = undefined;
        }
      } else if (isLiveStage() && extendedToken.role === "ADMIN") {
        const now = Math.floor(Date.now() / 1000);

        if (extendedToken.adminExpiresAt && now > extendedToken.adminExpiresAt) {
          // Admin session has expired in live mode; keep token but mark expiry.
          // Session and middleware will treat this as logged out.
          return token;
        }

        // Sliding window: extend admin session on activity while still valid.
        extendedToken.adminExpiresAt = now + ADMIN_SESSION_MAX_AGE_SECONDS;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        const extendedToken = token as ExtendedToken;

        if (isLiveStage() && extendedToken.role === "ADMIN") {
          const now = Math.floor(Date.now() / 1000);
          if (extendedToken.adminExpiresAt && now > extendedToken.adminExpiresAt) {
            // Admin session has expired in live mode; clear user data so
            // downstream checks treat this as logged out, but keep the
            // shape of Session to satisfy NextAuth v5 types.
            delete (session as { user?: unknown }).user;
            return session;
          }
        }

        const sessionUser = session.user as typeof session.user & {
          id: string;
          role?: Role;
          twoFactorEnabled?: boolean;
          phoneVerified?: boolean;
        };
        sessionUser.id = token.sub ?? "";
        sessionUser.role = extendedToken.role ?? "CUSTOMER";
        sessionUser.twoFactorEnabled = Boolean(extendedToken.mfaRequired);
        sessionUser.phoneVerified = Boolean(extendedToken.phoneVerified);
      }
      return session;
    },
  },

  pages: {
    signIn: "/login", // route to dedicated login page
  },
};
