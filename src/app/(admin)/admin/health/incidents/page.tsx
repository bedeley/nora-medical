import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function formatDate(value?: Date | null) {
  if (!value) return "-";
  return value.toLocaleString();
}

function formatAge(openedAt: Date) {
  const diffMs = Date.now() - openedAt.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

type IncidentStatusFilter = "ALL" | "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";

export default async function AdminHealthIncidentsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return (
      <section className="container mx-auto py-8">
        <p className="text-sm text-muted-foreground">Unauthorized.</p>
      </section>
    );
  }

  const params = (await searchParams) || {};
  const statusRaw = String(params.status || "ALL").toUpperCase();
  const status = (["ALL", "OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"].includes(statusRaw)
    ? statusRaw
    : "OPEN") as IncidentStatusFilter;
  const q = String(params.q || "").trim();
  const includeManual = String(params.includeManual || "0") === "1";
  const page = Math.max(1, Number(params.page || 1) || 1);
  const pageSize = 20;
  const skip = (page - 1) * pageSize;

  const where = {
    ...(includeManual ? {} : { isManual: false }),
    ...(status !== "ALL" ? { status } : {}),
    ...(q
      ? {
          OR: [
            { issueSummary: { contains: q, mode: "insensitive" as const } },
            { fingerprint: { contains: q, mode: "insensitive" as const } },
            {
              notes: {
                some: {
                  note: { contains: q, mode: "insensitive" as const },
                },
              },
            },
          ],
        }
      : {}),
  };

  const [incidents, total, counts] = await Promise.all([
    prisma.healthIncident.findMany({
      where,
      orderBy: { openedAt: "desc" },
      skip,
      take: pageSize,
      include: {
        notes: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    }),
    prisma.healthIncident.count({ where }),
    prisma.healthIncident.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const statusCounts = counts.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = row._count._all;
    return acc;
  }, {});

  return (
    <section className="container mx-auto py-6 max-w-6xl space-y-5">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold">Health Incidents</h1>
        <p className="text-sm text-muted-foreground">
          Incident-focused history for Health Check response and handoff.
        </p>
        <div className="flex flex-wrap gap-2 text-xs">
          <Link href="/admin/health" className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-muted">
            Back to Health Check
          </Link>
          <Link href="/admin/audit?sourcePage=admin/health/incidents" className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-muted">
            Open Audit Log
          </Link>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="grid gap-2 sm:grid-cols-3">
            <select name="status" defaultValue={status} className="h-9 rounded border bg-background px-2 text-sm">
              <option value="ALL">All statuses</option>
              <option value="OPEN">Open</option>
              <option value="IN_PROGRESS">In progress</option>
              <option value="RESOLVED">Resolved</option>
              <option value="CLOSED">Closed</option>
            </select>
            <input
              name="q"
              defaultValue={q}
              placeholder="Search summary/fingerprint/note"
              className="h-9 rounded border bg-background px-2 text-sm"
            />
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" name="includeManual" value="1" defaultChecked={includeManual} />
              Include manual incidents
            </label>
            <button type="submit" className="h-9 rounded border px-3 text-sm hover:bg-muted sm:col-span-3">
              Apply
            </button>
          </form>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>Open: {statusCounts.OPEN || 0}</span>
            <span>In progress: {statusCounts.IN_PROGRESS || 0}</span>
            <span>Resolved: {statusCounts.RESOLVED || 0}</span>
            <span>Closed: {statusCounts.CLOSED || 0}</span>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 md:hidden">
        {incidents.map((incident) => {
          const latestNote = incident.notes[0];
          return (
            <Card key={incident.id}>
              <CardContent className="pt-4 space-y-1 text-xs">
                <p className="font-medium">{incident.status.replace(/_/g, " ")}</p>
                <p>Type: {incident.isManual ? "Manual follow-up" : "Detector-backed"}</p>
                <p>Opened: {formatDate(incident.openedAt)} (age {formatAge(incident.openedAt)})</p>
                <p>Issue count: {incident.issueCount}</p>
                <p>Owner: {incident.ownerName || "Unassigned"}</p>
                <p>Summary: {incident.issueSummary}</p>
                <p>Fingerprint: {incident.fingerprint}</p>
                <p>Follow-up due: {formatDate(incident.followUpDueAt)}</p>
                <p>Resolved: {formatDate(incident.resolvedAt)}</p>
                <p>Latest note: {latestNote ? latestNote.note : "-"}</p>
                <div className="pt-1">
                  <Link
                    href={`/admin/health/incidents/${encodeURIComponent(incident.id)}`}
                    className="inline-flex items-center rounded-md border px-2 py-1 hover:bg-muted"
                  >
                    Manage incident
                  </Link>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="hidden md:block">
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Incident List</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="min-w-[1260px] w-full table-auto text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 text-left whitespace-nowrap">Status</th>
                <th className="py-2 pr-4 text-left whitespace-nowrap">Type</th>
                <th className="py-2 pr-4 text-left whitespace-nowrap">Opened</th>
                <th className="py-2 pr-4 text-left whitespace-nowrap">Issue Count</th>
                <th className="py-2 pr-4 text-left">Summary</th>
                <th className="py-2 pr-4 text-left whitespace-nowrap">Fingerprint</th>
                <th className="py-2 pr-4 text-left whitespace-nowrap">Follow-up Due</th>
                <th className="py-2 pr-4 text-left whitespace-nowrap">Resolved</th>
                <th className="py-2 pr-4 text-left whitespace-nowrap">Owner</th>
                <th className="py-2 text-left">Latest Note</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((incident) => {
                const latestNote = incident.notes[0];
                return (
                  <tr key={incident.id} className="border-t align-top">
                    <td className="py-3 pr-4 whitespace-nowrap">{incident.status.replace(/_/g, " ")}</td>
                    <td className="py-3 pr-4 whitespace-nowrap">{incident.isManual ? "Manual" : "Detector"}</td>
                    <td className="py-3 pr-4 whitespace-nowrap">
                      <div className="leading-tight">
                        <div>{formatDate(incident.openedAt)}</div>
                        <div className="text-xs text-muted-foreground">age {formatAge(incident.openedAt)}</div>
                      </div>
                    </td>
                    <td className="py-3 pr-4 whitespace-nowrap">{incident.issueCount}</td>
                    <td className="py-3 pr-4 max-w-[360px] whitespace-normal break-words">{incident.issueSummary}</td>
                    <td className="py-3 pr-4 font-mono text-xs break-all">{incident.fingerprint}</td>
                    <td className="py-3 pr-4 whitespace-nowrap">{formatDate(incident.followUpDueAt)}</td>
                    <td className="py-3 pr-4 whitespace-nowrap">{formatDate(incident.resolvedAt)}</td>
                    <td className="py-3 pr-4 whitespace-nowrap">
                      <div className="flex flex-col items-start gap-1">
                        <span>{incident.ownerName || "Unassigned"}</span>
                        <Link
                          href={`/admin/health/incidents/${encodeURIComponent(incident.id)}`}
                          className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs hover:bg-muted"
                        >
                          Manage
                        </Link>
                      </div>
                    </td>
                    <td className="py-3 max-w-[320px] whitespace-normal break-words">{latestNote ? latestNote.note : "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {incidents.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">No incidents found for this filter.</p>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-xs">
        <p className="text-muted-foreground">
          Page {page} of {totalPages} ({total} incident{total === 1 ? "" : "s"})
        </p>
        <div className="flex gap-2">
          <Link
            href={`/admin/health/incidents?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}&includeManual=${includeManual ? "1" : "0"}&page=${Math.max(1, page - 1)}`}
            className={`inline-flex items-center rounded-md border px-2 py-1 ${page <= 1 ? "pointer-events-none opacity-50" : "hover:bg-muted"}`}
          >
            Previous
          </Link>
          <Link
            href={`/admin/health/incidents?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}&includeManual=${includeManual ? "1" : "0"}&page=${Math.min(totalPages, page + 1)}`}
            className={`inline-flex items-center rounded-md border px-2 py-1 ${page >= totalPages ? "pointer-events-none opacity-50" : "hover:bg-muted"}`}
          >
            Next
          </Link>
        </div>
      </div>
    </section>
  );
}
