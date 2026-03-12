import { prisma } from "../../src/lib/prisma";

function getArg(name: string): string | null {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!raw) return null;
  return raw.slice(name.length + 3).trim() || null;
}

async function main() {
  const monthsArg = Number(getArg("months") || process.env.JOURNAL_ARCHIVE_AFTER_MONTHS || "18");
  const months = Number.isFinite(monthsArg) && monthsArg > 0 ? Math.floor(monthsArg) : 18;
  const dryRunArg = (getArg("dryRun") || "").toLowerCase();
  const dryRun = dryRunArg === "1" || dryRunArg === "true" || dryRunArg === "yes";

  const cutoffDate = new Date();
  cutoffDate.setUTCMonth(cutoffDate.getUTCMonth() - months);
  cutoffDate.setUTCHours(23, 59, 59, 999);

  const where = {
    archivedAt: null,
    entryDate: { lt: cutoffDate },
    status: { in: ["POSTED", "VOID"] as const },
  };

  const candidateCount = await prisma.journalEntry.count({ where });
  let archivedCount = 0;

  if (!dryRun && candidateCount > 0) {
    const res = await prisma.journalEntry.updateMany({
      where,
      data: { archivedAt: new Date() },
    });
    archivedCount = res.count;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun,
        months,
        cutoffDate: cutoffDate.toISOString(),
        candidateCount,
        archivedCount,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

