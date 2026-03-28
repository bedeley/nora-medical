import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  EMPLOYEE_PORTAL_HOME_PAGE,
  EMPLOYEE_PORTAL_LEAVE_PAGE,
  getEmployeePortalData,
} from "@/lib/employee-portal";
import { EmployeeLeaveSection } from "../EmployeeLeaveSection";

export const dynamic = "force-dynamic";

export default async function EmployeeLeavePage() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !user?.id) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/${EMPLOYEE_PORTAL_LEAVE_PAGE}`)}`);
  }
  const portal = await getEmployeePortalData(user.id);
  if (!portal) {
    redirect(`/${EMPLOYEE_PORTAL_HOME_PAGE}`);
  }

  return (
    <section className="container mx-auto max-w-5xl px-4 py-8">
      <Card className="mb-6 border shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>Leave history and requests</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Review your leave balance, calendar, and request history in one place.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link href={`/${EMPLOYEE_PORTAL_HOME_PAGE}`}>Back to portal</Link>
          </Button>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Use this page when you need the full leave timeline without the rest of the portal sections around it.
          </p>
        </CardContent>
      </Card>

      <EmployeeLeaveSection leaveSummary={portal.leaveSummary} leaveRequests={portal.employee.leaveRequests} />
    </section>
  );
}
