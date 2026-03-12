import { JournalStatus, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type Meta = Record<string, unknown>;

const TARGET_ACTIONS = [
  "journal.archive.dry_run",
  "journal.archive.run",
  "journal.archive.cron.dry_run",
  "journal.archive.cron.run",
  "journal.archive.undo",
] as const;

function parseMeta(raw: string | null): Meta | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Meta;
    }
  } catch {
    return null;
  }
  return null;
}

function asNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function withDefault<T>(value: T | null | undefined, fallback: T) {
  return value == null ? fallback : value;
}

async function main() {
  const configuredMonths = Number(process.env.JOURNAL_ARCHIVE_AFTER_MONTHS || "18");
  const defaultMonths = Number.isFinite(configuredMonths) && configuredMonths > 0
    ? Math.floor(configuredMonths)
    : 18;
  const nowIso = new Date().toISOString();

  let cursor: string | null = null;
  let scanned = 0;
  let updated = 0;

  while (true) {
    const rows = await prisma.auditLog.findMany({
      where: { action: { in: [...TARGET_ACTIONS] } },
      orderBy: { id: "asc" },
      take: 300,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        action: true,
        createdAt: true,
        actorId: true,
        meta: true,
        actor: { select: { id: true, name: true, email: true, role: true } },
      },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      const parsed = parseMeta(row.meta);
      if (!parsed) continue;

      const trigger = row.action.includes(".cron.") ? "cron" : "manual";
      const dryRun = Boolean(
        parsed.dryRun ??
          row.action.endsWith(".dry_run"),
      );

      if (row.action === "journal.archive.undo") {
        const restoredCount = asNumber(parsed.restoredCount, 0);
        const nextMeta: Meta = {
          ...parsed,
          undoRequestedAt: withDefault(
            typeof parsed.undoRequestedAt === "string" ? parsed.undoRequestedAt : null,
            nowIso,
          ),
          undoWindowMinutes: withDefault(asNumber(parsed.undoWindowMinutes, 5), 5),
          actorId: withDefault(
            typeof parsed.actorId === "string" ? parsed.actorId : null,
            row.actor?.id || row.actorId || null,
          ),
          actorName: withDefault(
            typeof parsed.actorName === "string" ? parsed.actorName : null,
            row.actor?.name || null,
          ),
          actorEmail: withDefault(
            typeof parsed.actorEmail === "string" ? parsed.actorEmail : null,
            row.actor?.email || null,
          ),
          actorRole: withDefault(
            typeof parsed.actorRole === "string" ? parsed.actorRole : null,
            row.actor?.role || null,
          ),
          archivePolicyVersion: withDefault(asNumber(parsed.archivePolicyVersion, 2), 2),
          resultSummary: withDefault(
            typeof parsed.resultSummary === "string" ? parsed.resultSummary : null,
            restoredCount > 0
              ? `${restoredCount} archived entries restored.`
              : "No entries matched the selected archive batch.",
          ),
        };
        if (JSON.stringify(nextMeta) !== JSON.stringify(parsed)) {
          await prisma.auditLog.update({
            where: { id: row.id },
            data: { meta: JSON.stringify(nextMeta) },
          });
          updated += 1;
        }
        continue;
      }

      const months = asNumber(parsed.months, defaultMonths);
      const candidateCount = asNumber(parsed.candidateCount, 0);
      const archivedCount = asNumber(parsed.archivedCount, 0);
      const nextMeta: Meta = {
        ...parsed,
        trigger: withDefault(typeof parsed.trigger === "string" ? parsed.trigger : null, trigger),
        monthsSource: withDefault(
          typeof parsed.monthsSource === "string" ? parsed.monthsSource : null,
          "legacy-default",
        ),
        defaultMonths: withDefault(asNumber(parsed.defaultMonths, defaultMonths), defaultMonths),
        includedStatuses: Array.isArray(parsed.includedStatuses)
          ? parsed.includedStatuses
          : [JournalStatus.POSTED, JournalStatus.VOID],
        actorId: withDefault(
          typeof parsed.actorId === "string" ? parsed.actorId : null,
          row.actor?.id || row.actorId || null,
        ),
        actorName: withDefault(
          typeof parsed.actorName === "string" ? parsed.actorName : null,
          row.actor?.name || null,
        ),
        actorEmail: withDefault(
          typeof parsed.actorEmail === "string" ? parsed.actorEmail : null,
          row.actor?.email || null,
        ),
        actorRole: withDefault(
          typeof parsed.actorRole === "string" ? parsed.actorRole : null,
          row.actor?.role || null,
        ),
        archivePolicyVersion: withDefault(asNumber(parsed.archivePolicyVersion, 2), 2),
        resultSummary: withDefault(
          typeof parsed.resultSummary === "string" ? parsed.resultSummary : null,
          dryRun
            ? `Dry run only. ${candidateCount} entries would be archived.`
            : archivedCount > 0
              ? `${archivedCount} entries archived.`
              : "No entries archived.",
        ),
        noOpReason: withDefault(
          typeof parsed.noOpReason === "string" ? parsed.noOpReason : null,
          candidateCount === 0
            ? "No eligible entries found under current archive policy."
            : dryRun
              ? "Dry run mode enabled."
              : null,
        ),
        months,
      };

      if (JSON.stringify(nextMeta) !== JSON.stringify(parsed)) {
        await prisma.auditLog.update({
          where: { id: row.id },
          data: { meta: JSON.stringify(nextMeta) },
        });
        updated += 1;
      }
    }

    cursor = rows[rows.length - 1]?.id || null;
  }

  console.log(JSON.stringify({ scanned, updated, defaultMonths, actions: TARGET_ACTIONS }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

