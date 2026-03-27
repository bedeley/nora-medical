import { prisma } from "@/lib/prisma";
import { normalizeGhanaStatutoryConfig } from "@/lib/hr-ghana-statutory-core";

export * from "@/lib/hr-ghana-statutory-core";

export async function getGhanaStatutoryConfigFromSettings() {
  const rows = await prisma.siteSetting.findMany({
    where: {
      key: {
        in: [
          "hr.payroll.ghana.autoStatutoryCalc",
          "hr.payroll.ghana.enablePaye",
          "hr.payroll.ghana.enableSsnitEmployee",
          "hr.payroll.ghana.enableSsnitEmployer",
          "hr.payroll.ghana.ssnitEmployeeRate",
          "hr.payroll.ghana.ssnitEmployerRate",
          "hr.payroll.ghana.taxableAllowancePercent",
          "hr.payroll.ghana.payeBands",
        ],
      },
    },
  });
  const map = new Map(rows.map((row) => [row.key, row.value]));
  return normalizeGhanaStatutoryConfig({
    autoStatutoryCalc: map.get("hr.payroll.ghana.autoStatutoryCalc"),
    enablePaye: map.get("hr.payroll.ghana.enablePaye"),
    enableSsnitEmployee: map.get("hr.payroll.ghana.enableSsnitEmployee"),
    enableSsnitEmployer: map.get("hr.payroll.ghana.enableSsnitEmployer"),
    ssnitEmployeeRate: map.get("hr.payroll.ghana.ssnitEmployeeRate"),
    ssnitEmployerRate: map.get("hr.payroll.ghana.ssnitEmployerRate"),
    taxableAllowancePercent: map.get("hr.payroll.ghana.taxableAllowancePercent"),
    payeBands: map.get("hr.payroll.ghana.payeBands"),
  });
}
