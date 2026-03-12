import { PrismaAdapter } from "@auth/prisma-adapter";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import bcrypt from "bcrypt";
import type { AuthOptions } from "next-auth";
import type { JWT } from "next-auth/jwt";
import type { Role } from "@/lib/prisma-enums";
import { ADMIN_SESSION_MAX_AGE_SECONDS, isLiveStage } from "@/lib/env";
import { decode as defaultJwtDecode, encode as defaultJwtEncode } from "next-auth/jwt";
import { rateLimit, checkLoginLockout, recordLoginFailure, clearLoginFailures } from "@/lib/rate-limit";

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
    maxAge: 60 * 60 * 24, // 24 hours
    updateAge: 60 * 30, // rotate token at most every 30 minutes
  },

  jwt: {
    encode: defaultJwtEncode,
    maxAge: 60 * 60 * 24,
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
      async authorize(credentials, req) {
        const schema = z.object({
          identifier: z.string().min(3),
          password: z.string().min(6),
        });

        const parsed = schema.safeParse(credentials);
        if (!parsed.success) return null;

        const { identifier, password } = parsed.data;
        const raw = identifier.trim();
        const isEmail = raw.includes("@");

        // Basic login rate limiting: IP + identifier bucket
        if (req) {
          try {
            const limited = await rateLimit(
              req as unknown as Request,
              `login:${raw.toLowerCase()}`,
              60_000,
              5,
            );
            if (!limited.ok) {
              console.warn("[auth] login rate limit exceeded", {
                identifier: raw.toLowerCase(),
              });
              return null;
            }
          } catch (e) {
            console.warn("[auth] login rate limit check failed", e);
          }
        }

        if (req) {
          const lockout = await checkLoginLockout(req as unknown as Request, raw.toLowerCase());
          if (lockout.locked) {
            console.warn("[auth] login locked out", {
              identifier: raw.toLowerCase(),
              retryInMs: lockout.retryIn,
            });
            return null;
          }
        }

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
            archived: true,
          },
        });
        if (!user) {
          console.warn("[auth] login failed: user not found", { identifier: raw });
          if (req) {
            await recordLoginFailure(req as unknown as Request, raw.toLowerCase());
          }
          return null;
        }
        if (user.archived) {
          console.warn("[auth] login blocked: user archived", { userId: user.id });
          return null;
        }

        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) {
          console.warn("[auth] login failed: bad password", { userId: user.id });
          if (req) {
            await recordLoginFailure(req as unknown as Request, raw.toLowerCase());
          }
          return null;
        }

        if (req) {
          await clearLoginFailures(req as unknown as Request, raw.toLowerCase());
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

  debug: process.env.NEXTAUTH_DEBUG === "1",
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

      // Enforce forced logout / archived users on subsequent requests.
      if (!user && token?.sub) {
        const role = (extendedToken.role ?? "CUSTOMER") as Role | string;
        const privileged = ["ADMIN", "STAFF", "ACCOUNTANT", "DISPATCHER"].includes(String(role));
        if (privileged) {
          try {
            const refreshed = await prisma.user.findUnique({
              where: { id: String(token.sub) },
              select: { archived: true, sessionInvalidBefore: true },
            });
            if (!refreshed || refreshed.archived) {
              return {};
            }
            if (refreshed.sessionInvalidBefore) {
              const invalidBefore = Math.floor(
                refreshed.sessionInvalidBefore.getTime() / 1000,
              );
              const tokenIat = typeof token.iat === "number" ? token.iat : 0;
              if (tokenIat < invalidBefore) {
                return {};
              }
            }
          } catch (e) {
            console.warn("[auth] forced logout check failed", e);
          }
        }
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
        let resolvedRole = extendedToken.role ?? "CUSTOMER";
        let resolvedMfa = Boolean(extendedToken.mfaRequired);
        let resolvedPhone = Boolean(extendedToken.phoneVerified);

        const privileged = ["ADMIN", "STAFF", "ACCOUNTANT"].includes(String(resolvedRole));
        if (sessionUser.id && privileged) {
          try {
            const refreshed = await prisma.user.findUnique({
              where: { id: sessionUser.id },
              select: {
                role: true,
                twoFactorEnabled: true,
                phoneVerifiedAt: true,
                archived: true,
                sessionInvalidBefore: true,
              },
            });
            if (!refreshed || refreshed.archived) {
              delete (session as { user?: unknown }).user;
              return session;
            }
            if (refreshed.sessionInvalidBefore) {
              const invalidBefore = Math.floor(refreshed.sessionInvalidBefore.getTime() / 1000);
              const tokenIat = typeof token.iat === "number" ? token.iat : 0;
              if (tokenIat < invalidBefore) {
                delete (session as { user?: unknown }).user;
                return session;
              }
            }
            resolvedRole = refreshed.role;
            resolvedMfa = refreshed.role === "ADMIN" && Boolean(refreshed.twoFactorEnabled);
            resolvedPhone = Boolean(refreshed.phoneVerifiedAt);
          } catch (e) {
            console.warn("[auth] role refresh failed", e);
          }
        }

        sessionUser.role = resolvedRole;
        sessionUser.twoFactorEnabled = resolvedMfa;
        sessionUser.phoneVerified = resolvedPhone;
      }
      return session;
    },
  },

  events: {
    async signIn({ user }) {
      if (!user?.id) return;
      try {
        await prisma.user.update({
          where: { id: user.id as string },
          data: { lastLoginAt: new Date() },
        });
      } catch (e) {
        console.warn("[auth] failed to update lastLoginAt", e);
      }
    },
  },

  pages: {
    signIn: "/login", // route to dedicated login page
  },
};
