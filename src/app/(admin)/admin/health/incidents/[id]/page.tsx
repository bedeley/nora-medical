import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import HealthIncidentDetailPanel from "@/components/admin/HealthIncidentDetailPanel";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function AdminHealthIncidentDetailPage({ params }: PageProps) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return (
      <section className="container mx-auto py-8">
        <p className="text-sm text-muted-foreground">Unauthorized.</p>
      </section>
    );
  }

  const { id } = await params;
  const [incident, admins] = await Promise.all([
    prisma.healthIncident.findUnique({
      where: { id },
      include: {
        openedBy: { select: { name: true, email: true } },
        resolvedBy: { select: { name: true, email: true } },
        notes: {
          orderBy: { createdAt: "desc" },
          take: 20,
          select: { id: true, note: true, createdAt: true, createdByName: true },
        },
      },
    }),
    prisma.user.findMany({
      where: { role: "ADMIN", deletedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true },
    }),
  ]);

  if (!incident) {
    return (
      <section className="container mx-auto py-8">
        <p className="text-sm text-muted-foreground">Incident not found.</p>
      </section>
    );
  }

  return (
    <section className="container mx-auto py-6 max-w-5xl">
      <HealthIncidentDetailPanel
        admins={admins.map((row) => ({
          id: row.id,
          name: row.name || row.email || "Admin",
          email: row.email || "",
        }))}
        initialIncident={{
          id: incident.id,
          fingerprint: incident.fingerprint,
          issueCount: incident.issueCount,
          issueSummary: incident.issueSummary,
          isManual: incident.isManual,
          status: incident.status,
          ownerId: incident.ownerId,
          ownerName: incident.ownerName,
          followUpDueAt: incident.followUpDueAt ? incident.followUpDueAt.toISOString() : null,
          openedAt: incident.openedAt.toISOString(),
          resolvedAt: incident.resolvedAt ? incident.resolvedAt.toISOString() : null,
          closedAt: incident.closedAt ? incident.closedAt.toISOString() : null,
          openedByName: incident.openedBy?.name || incident.openedBy?.email || null,
          resolvedByName: incident.resolvedBy?.name || incident.resolvedBy?.email || null,
          notes: incident.notes.map((row) => ({
            id: row.id,
            note: row.note,
            createdAt: row.createdAt.toISOString(),
            createdByName: row.createdByName,
          })),
        }}
      />
    </section>
  );
}

