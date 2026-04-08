import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { ensureEmployeeProfileForUser } from "@/lib/hr-user-employee-profile";

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const email = getArg("--email") || process.env.ADMIN_EMAIL;
  const password = getArg("--password") || process.env.ADMIN_PASSWORD;
  const name = getArg("--name") || process.env.ADMIN_NAME || "Admin";

  if (!email || !password) {
    console.error(
      "Usage: pnpm create-admin --email you@example.com --password \"StrongPass123\" [--name \"Admin Name\"]"
    );
    console.error(
      "Or set ADMIN_EMAIL and ADMIN_PASSWORD environment variables."
    );
    process.exit(1);
  }

  if (password.length < 6) {
    console.error("Password must be at least 6 characters long.");
    process.exit(1);
  }

  const hashed = await bcrypt.hash(password, 10);

  const user = await prisma.user.upsert({
    where: { email },
    update: {
      password: hashed,
      role: "ADMIN",
      name,
    },
    create: {
      email,
      name,
      password: hashed,
      role: "ADMIN",
    },
  });
  const employeeProfile = await ensureEmployeeProfileForUser(prisma, {
    userId: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    status: "ACTIVE",
  });

  console.log("Admin user ready:", {
    id: user.id,
    email: user.email,
    role: user.role,
    employeeId: employeeProfile.employeeId,
    profileOutcome: employeeProfile.outcome,
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
