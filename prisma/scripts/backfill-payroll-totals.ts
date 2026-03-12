import { prisma } from "@/lib/prisma";

function toNumber(value: unknown) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

async function main() {
  const runs = await prisma.payrollRun.findMany({
    select: { id: true, status: true, totalGross: true, totalNet: true },
  });

  let updated = 0;
  let skipped = 0;

  for (const run of runs) {
    const totals = await prisma.payslip.aggregate({
      where: { payrollRunId: run.id },
      _sum: { grossPay: true, netPay: true },
    });
    const gross = toNumber(totals._sum.grossPay);
    const net = toNumber(totals._sum.netPay);

    if (run.status === "CANCELLED") {
      if (gross !== 0 || net !== 0) {
        console.warn(
          `Cancelled run ${run.id} has payslip totals gross=${gross} net=${net}; leaving as-is.`
        );
      }
      skipped += 1;
      continue;
    }

    const existingGross = toNumber(run.totalGross);
    const existingNet = toNumber(run.totalNet);
    if (existingGross === gross && existingNet === net) {
      skipped += 1;
      continue;
    }

    await prisma.payrollRun.update({
      where: { id: run.id },
      data: { totalGross: gross, totalNet: net },
    });
    updated += 1;
  }

  console.log(`Payroll totals backfill complete. Updated: ${updated}, Skipped: ${skipped}`);
}

main()
  .catch((err) => {
    console.error("Failed to backfill payroll totals:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
