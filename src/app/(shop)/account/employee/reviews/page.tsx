import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateGH, formatDateTimeGH } from "@/lib/currency";
import {
  EMPLOYEE_PORTAL_HOME_PAGE,
  EMPLOYEE_PORTAL_REVIEWS_PAGE,
  employeePortalReviewsEnabled,
  getEmployeePortalData,
} from "@/lib/employee-portal";
import { EmployeePortalAcknowledgeButton } from "../EmployeePortalAcknowledgeButton";

export const dynamic = "force-dynamic";

function toPlainLabel(value: string | null | undefined) {
  const normalized = String(value || "").replace(/[._-]+/g, " ").trim();
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase() : "";
}

function reviewSummaryFallback(review: {
  summary: string | null;
  strengths: string | null;
  improvements: string | null;
  goals: string | null;
}) {
  return review.summary || review.strengths || review.improvements || review.goals || "No written summary was added.";
}

export default async function EmployeeReviewsPage() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !user?.id) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/${EMPLOYEE_PORTAL_REVIEWS_PAGE}`)}`);
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
            <CardTitle>All review summaries</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Leadership can publish selected review summaries here for employee visibility.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link href={`/${EMPLOYEE_PORTAL_HOME_PAGE}`}>Back to portal</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {!employeePortalReviewsEnabled() ? (
            <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              Review summaries are currently hidden from the employee portal.
            </div>
          ) : portal.reviews.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              No employee-visible review summaries are available yet.
            </div>
          ) : (
            <div className="grid gap-3">
              {portal.reviews.map((review) => (
                <div key={review.id} className="rounded-2xl border border-border/70 bg-background/60 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{toPlainLabel(review.rating)}</Badge>
                    <Badge variant="outline">{toPlainLabel(review.workflowStatus)}</Badge>
                  </div>
                  <p className="mt-3 font-semibold text-foreground">
                    {formatDateGH(review.periodStart)} to {formatDateGH(review.periodEnd)}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">{reviewSummaryFallback(review)}</p>
                  <p className="mt-3 text-xs text-muted-foreground">Recorded {formatDateTimeGH(review.createdAt)}</p>
                  <div className="mt-3">
                    <EmployeePortalAcknowledgeButton
                      path={`/api/account/employee/reviews/${review.id}/acknowledge`}
                      label="review"
                      acknowledged={Boolean(review.acknowledged)}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
