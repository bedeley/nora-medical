import { PrismaAdapter } from "@auth/prisma-adapter";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import bcrypt from "bcryptjs";
import type { AuthOptions } from "next-auth";
import type { JWT } from "next-auth/jwt";
import type { Role } from "@/lib/prisma-enums";
import { ADMIN_SESSION_MAX_AGE_SECONDS, isLiveStage } from "@/lib/env";
import { decode as defaultJwtDecode, encode as defaultJwtEncode } from "next-auth/jwt";
import { rateLimit, checkLoginLockout, recordLoginFailure, clearLoginFailures } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

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
          password: z.string().min(10),
        });
        const describeValidationIssue = (issue: z.ZodIssue) => {
          const field = issue.path.length > 0 ? issue.path.join(".") : "credentials";
          if (field === "password" && issue.code === "too_small") {
            return "Password was shorter than the 10-character minimum.";
          }
          if (field === "identifier" && issue.code === "too_small") {
            return "Identifier was shorter than the 3-character minimum.";
          }
          if (issue.code === "invalid_type") {
            return `${field === "credentials" ? "Credentials" : humanizeField(field)} was missing or invalid.`;
          }
          return `${field === "credentials" ? "Credentials" : humanizeField(field)} failed validation.`;
        };
        const humanizeField = (value: string) =>
          value
            .replace(/[_-]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .replace(/\b\w/g, (char) => char.toUpperCase());

        const rawIdentifier =
          typeof credentials?.identifier === "string" ? credentials.identifier.trim() : "";
        const isEmail = rawIdentifier.includes("@");
        const normalizedIdentifier = rawIdentifier.toLowerCase();
        const auditEntityId = normalizedIdentifier || "invalid_identifier";
        const logFailedLogin = async (details: {
          entityType: string;
          entityId: string;
          actorId?: string | null;
          reason: string;
          email?: string | null;
          role?: string | null;
          validationErrors?: string[];
        }) => {
          try {
            await recordAuditLog({
              actorId: details.actorId || null,
              action: "USER_LOGIN_FAILED",
              entityType: details.entityType,
              entityId: details.entityId,
              request: req,
              outcome: "FAILED",
              meta: {
                identifier: normalizedIdentifier || null,
                email: details.email ?? (isEmail ? normalizedIdentifier : null),
                role: details.role ?? null,
                reason: details.reason,
                validationErrors: details.validationErrors ?? null,
              },
            });
          } catch (error) {
            console.warn("[auth] failed to record failed login audit event", error);
          }
        };

        const parsed = schema.safeParse(credentials);
        if (!parsed.success) {
          await logFailedLogin({
            entityType: "AUTH",
            entityId: auditEntityId,
            reason: "Login request failed validation.",
            validationErrors: parsed.error.issues.map(describeValidationIssue),
          });
          return null;
        }

        const { identifier, password } = parsed.data;
        const raw = identifier.trim();

        // Basic login rate limiting: IP + identifier bucket
        if (req) {
          try {
            const limited = await rateLimit(
              req as unknown as Request,
              `login:${normalizedIdentifier}`,
              60_000,
              5,
            );
            if (!limited.ok) {
              console.warn("[auth] login rate limit exceeded", {
                identifier: normalizedIdentifier,
              });
              await logFailedLogin({
                entityType: "AUTH",
                entityId: normalizedIdentifier,
                reason: "rate_limited",
              });
              return null;
            }
          } catch (e) {
            console.warn("[auth] login rate limit check failed", e);
          }
        }

        if (req) {
          const lockout = await checkLoginLockout(req as unknown as Request, normalizedIdentifier);
          if (lockout.locked) {
            console.warn("[auth] login locked out", {
              identifier: normalizedIdentifier,
              retryInMs: lockout.retryIn,
            });
            await logFailedLogin({
              entityType: "AUTH",
              entityId: normalizedIdentifier,
              reason: "locked_out",
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
            await recordLoginFailure(req as unknown as Request, normalizedIdentifier);
          }
          await logFailedLogin({
            entityType: "AUTH",
            entityId: normalizedIdentifier,
            reason: "user_not_found",
          });
          return null;
        }
        if (user.archived) {
          console.warn("[auth] login blocked: user archived", { userId: user.id });
          await logFailedLogin({
            actorId: user.id,
            entityType: "USER",
            entityId: user.id,
            reason: "user_archived",
            email: user.email,
            role: user.role,
          });
          return null;
        }

        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) {
          console.warn("[auth] login failed: bad password", { userId: user.id });
          if (req) {
            await recordLoginFailure(req as unknown as Request, normalizedIdentifier);
          }
          await logFailedLogin({
            actorId: user.id,
            entityType: "USER",
            entityId: user.id,
            reason: "bad_password",
            email: user.email,
            role: user.role,
          });
          return null;
        }

        if (req) {
          await clearLoginFailures(req as unknown as Request, normalizedIdentifier);
        }

        try {
          await prisma.user.update({
            where: { id: user.id },
            data: { lastLoginAt: new Date() },
          });
        } catch (e) {
          console.warn("[auth] failed to update lastLoginAt", e);
        }

        try {
          await recordAuditLog({
            actorId: user.id,
            action: "USER_LOGIN",
            entityType: "USER",
            entityId: user.id,
            request: req,
            outcome: "SUCCESS",
            meta: {
              email: user.email,
              role: user.role,
              provider: "credentials",
            },
          });
        } catch (e) {
          console.warn("[auth] failed to record login audit event", e);
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
    async signIn({ user, account }) {
      if (!user?.id) return;
      if (account?.provider === "credentials") return;
      const authUser = user as AuthenticatedUser;
      try {
        await prisma.user.update({
          where: { id: user.id as string },
          data: { lastLoginAt: new Date() },
        });
      } catch (e) {
        console.warn("[auth] failed to update lastLoginAt", e);
      }
      try {
        await recordAuditLog({
          actorId: authUser.id,
          action: "USER_LOGIN",
          entityType: "USER",
          entityId: authUser.id,
          outcome: "SUCCESS",
          meta: {
            email: authUser.email,
            role: authUser.role,
            provider: account?.provider || "unknown",
          },
        });
      } catch (e) {
        console.warn("[auth] failed to record login audit event", e);
      }
    },
  },

  pages: {
    signIn: "/login", // route to dedicated login page
  },
};
