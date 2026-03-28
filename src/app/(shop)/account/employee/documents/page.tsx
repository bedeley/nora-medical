import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateGH, formatDateTimeGH } from "@/lib/currency";
import {
  EMPLOYEE_PORTAL_DOCUMENTS_PAGE,
  EMPLOYEE_PORTAL_HOME_PAGE,
  getEmployeePortalData,
} from "@/lib/employee-portal";
import { EmployeePortalAcknowledgeButton } from "../EmployeePortalAcknowledgeButton";

export const dynamic = "force-dynamic";

export default async function EmployeeDocumentsPage() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !user?.id) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/${EMPLOYEE_PORTAL_DOCUMENTS_PAGE}`)}`);
  }
  const portal = await getEmployeePortalData(user.id);
  if (!portal) {
    redirect(`/${EMPLOYEE_PORTAL_HOME_PAGE}`);
  }

  return (
    <section className="container mx-auto max-w-5xl px-4 py-8">
      <Card className="border shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>All HR documents</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Review and download every HR document that has been published to your employee portal.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link href={`/${EMPLOYEE_PORTAL_HOME_PAGE}`}>Back to portal</Link>
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3">
          {portal.employee.documents.map((doc) => (
            <div key={doc.id} className="rounded-2xl border border-border/70 bg-background/60 p-4">
              <p className="font-semibold text-foreground">{doc.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {doc.fileType || "Document"} | Uploaded {formatDateGH(doc.uploadedAt)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {doc.acknowledged
                  ? `Acknowledged ${formatDateTimeGH(doc.acknowledgedAt || doc.uploadedAt)}`
                  : "Not acknowledged yet"}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {String(doc.fileType || "").toLowerCase().includes("pdf") ||
                String(doc.fileType || "").toLowerCase().startsWith("image/") ? (
                  <Button asChild size="sm" variant="outline">
                    <a href={`/api/account/employee/documents/${doc.id}/preview`} target="_blank" rel="noreferrer">
                      Preview
                    </a>
                  </Button>
                ) : null}
                <Button asChild size="sm" variant="outline">
                  <a href={`/api/account/employee/documents/${doc.id}/download`}>Download</a>
                </Button>
                <EmployeePortalAcknowledgeButton
                  path={`/api/account/employee/documents/${doc.id}/acknowledge`}
                  label="document"
                  acknowledged={Boolean(doc.acknowledged)}
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}
