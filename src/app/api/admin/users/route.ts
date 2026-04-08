import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin, getAllowedOriginFromEnv } from "@/lib/origin";
import { clearOtpFailures, rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { Role } from "@/lib/prisma-enums";
import { sendEmail } from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { sendWhatsApp } from "@/lib/whatsapp";
import { ensureEmployeeProfileForUser } from "@/lib/hr-user-employee-profile";

const createUserSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  phone: z.string().trim().min(7),
  role: z.enum(["ADMIN", "STAFF", "ACCOUNTANT", "DISPATCHER"]),
  employeeId: z.string().optional().or(z.literal("")),
  sourcePage: z.string().optional().or(z.literal("")),
  section: z.string().optional().or(z.literal("")),
  operation: z.string().optional().or(z.literal("")),
  resultSummary: z.string().optional().or(z.literal("")),
});

function titleCase(value: string) {
  return String(value || "").replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function generateTempPassword(length = 12) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  let out = "";
  const bytes = randomBytes(length);
  for (let i = 0; i < bytes.length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await rateLimit(req, "admin-user-create", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = await req.json();
    const parsed = createUserSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const normalizedEmail = parsed.data.email.toLowerCase().trim();
    const normalizedPhone = parsed.data.phone.trim();
    const employeeId = String(parsed.data.employeeId || "").trim();
    const sourcePage = String(parsed.data.sourcePage || "").trim();
    const section = String(parsed.data.section || "").trim();
    const operation = String(parsed.data.operation || "").trim();
    const resultSummary = String(parsed.data.resultSummary || "").trim();

    const existingEmail = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });
    if (existingEmail) {
      return NextResponse.json({ error: "Email already in use" }, { status: 409 });
    }
    const existingPhone = await prisma.user.findUnique({
      where: { phone: normalizedPhone },
      select: { id: true },
    });
    if (existingPhone) {
      return NextResponse.json({ error: "Phone already in use" }, { status: 409 });
    }

    const targetEmployee = employeeId
      ? await prisma.employee.findUnique({
          where: { id: employeeId },
          select: {
            id: true,
            userId: true,
            email: true,
            phone: true,
          },
        })
      : null;

    if (employeeId && !targetEmployee) {
      return NextResponse.json({ error: "Employee not found" }, { status: 404 });
    }

    if (targetEmployee?.userId) {
      return NextResponse.json({ error: "Employee already has a linked user account." }, { status: 409 });
    }

    if (targetEmployee?.email && targetEmployee.email.toLowerCase().trim() !== normalizedEmail) {
      return NextResponse.json(
        { error: "User email must match the employee email already stored on the profile." },
        { status: 409 },
      );
    }

    if (targetEmployee?.phone && targetEmployee.phone.trim() !== normalizedPhone) {
      return NextResponse.json(
        { error: "User phone must match the employee phone already stored on the profile." },
        { status: 409 },
      );
    }

    const tempPassword = generateTempPassword(18);
    const hashed = await bcrypt.hash(tempPassword, 10);

    const created = await prisma.$transaction(async (tx) => {
      const userRecord = await tx.user.create({
        data: {
          name: titleCase(parsed.data.name),
          email: normalizedEmail,
          phone: normalizedPhone,
          password: hashed,
          role: Role[parsed.data.role],
        },
        select: { id: true, email: true, role: true, name: true, phone: true },
      });

      if (targetEmployee) {
        await tx.employee.update({
          where: { id: targetEmployee.id },
          data: {
            userId: userRecord.id,
            ...(targetEmployee.email ? {} : { email: userRecord.email }),
            ...(targetEmployee.phone ? {} : { phone: userRecord.phone }),
          },
        });
      } else {
        await ensureEmployeeProfileForUser(tx, {
          userId: userRecord.id,
          name: userRecord.name || parsed.data.name,
          email: userRecord.email,
          phone: userRecord.phone,
          status: "ACTIVE",
        });
      }

      return userRecord;
    });

    const inviteCode = String(Math.floor(100000 + Math.random() * 900000));
    const inviteHash = await bcrypt.hash(inviteCode, 10);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.userOtp.deleteMany({
      where: { userId: created.id, purpose: "employee_invite" },
    });

    await prisma.userOtp.create({
      data: {
        userId: created.id,
        purpose: "employee_invite",
        codeHash: inviteHash,
        expiresAt,
      },
    });
    await clearOtpFailures("employee_invite", created.id);

    const origin = getAllowedOriginFromEnv(req.url) || "http://localhost:3000";
    const inviteUrl = `${origin}/invite?userId=${created.id}`;
    const subject = "Your Noralls employee invite";
    const message = [
      `Hi ${created.email},`,
      "",
      "You have been invited to Noralls Medical Supplies.",
      "",
      `Invite link: ${inviteUrl}`,
      `Verification code: ${inviteCode}`,
      "",
      "Enter the code within 24 hours to set your password.",
    ].join("\n");

    let channel: "email" | "sms" | "whatsapp" | "none" = "none";
    const emailResult = await sendEmail(normalizedEmail, subject, message);
    if (emailResult.ok) {
      channel = "email";
    } else {
      const smsResult = await sendSms(normalizedPhone, message).catch(() => ({ ok: false }));
      if (smsResult?.ok) {
        channel = "sms";
      } else {
        const waResult = await sendWhatsApp(normalizedPhone, message).catch(() => ({ ok: false }));
        if (waResult?.ok) {
          channel = "whatsapp";
        } else {
          const retryEmail = await sendEmail(normalizedEmail, subject, message);
          if (retryEmail.ok) channel = "email";
        }
      }
    }

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "USER_CREATE",
        entityType: "User",
        entityId: created.id,
        meta: {
          role: created.role,
          email: created.email,
          employeeId: targetEmployee?.id ?? null,
          ...(sourcePage ? { page: sourcePage, sourcePage } : {}),
          ...(section ? { section } : {}),
          ...(operation ? { operation } : {}),
          ...(resultSummary
            ? { resultSummary }
            : targetEmployee
              ? { resultSummary: "Linked user account created successfully." }
              : {}),
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({
      id: created.id,
      email: created.email,
      role: created.role,
      employeeId: targetEmployee?.id ?? null,
      inviteUrl,
      channel,
    });
  } catch (error) {
    console.error("Admin user create error:", error);
    return NextResponse.json({ error: "Failed to create user" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const includeArchived = url.searchParams.get("includeArchived") === "1";

  try {
    const users = await prisma.user.findMany({
      where: {
        role: { in: [Role.ADMIN, Role.STAFF, Role.ACCOUNTANT, Role.DISPATCHER] },
        ...(includeArchived ? {} : { archived: false }),
      },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        role: true,
        archived: true,
        lastLoginAt: true,
        createdAt: true,
        employeeProfile: { select: { id: true } },
      },
    });

    const userIds = users.map((u) => u.id);
    const roleLogs = await prisma.auditLog.findMany({
      where: {
        action: "USER_ROLE_UPDATE",
        entityType: "USER",
        entityId: { in: userIds },
      },
      orderBy: { createdAt: "desc" },
      include: { actor: { select: { id: true, name: true, email: true } } },
    });
    const latestRoleLog = new Map<string, (typeof roleLogs)[number]>();
    for (const log of roleLogs) {
      if (!latestRoleLog.has(log.entityId)) {
        latestRoleLog.set(log.entityId, log);
      }
    }

    const protectedEmails = String(process.env.PROTECTED_ADMIN_EMAILS || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    return NextResponse.json({
      rows: users.map((u) => ({
        user: {
          id: u.id,
          email: u.email,
          name: u.name,
          phone: u.phone,
          role: u.role,
          archived: u.archived,
          isProtected:
            u.role === "ADMIN" &&
            !!u.email &&
            protectedEmails.includes(u.email.toLowerCase()),
          lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
          createdAt: u.createdAt.toISOString(),
          employeeId: u.employeeProfile?.id ?? null,
          lastRoleChange: (() => {
            const log = latestRoleLog.get(u.id);
            if (!log) return null;
            let meta: { from?: string; to?: string } | null = null;
            if (log.meta) {
              try {
                meta = JSON.parse(log.meta) as { from?: string; to?: string };
              } catch {
                meta = null;
              }
            }
            return {
              at: log.createdAt.toISOString(),
              by: log.actor
                ? {
                    id: log.actor.id,
                    name: log.actor.name,
                    email: log.actor.email,
                  }
                : null,
              from: meta?.from ?? null,
              to: meta?.to ?? null,
            };
          })(),
        },
      })),
    });
  } catch (error) {
    console.error("Admin users list error:", error);
    return NextResponse.json({ error: "Failed to load users" }, { status: 500 });
  }
}
