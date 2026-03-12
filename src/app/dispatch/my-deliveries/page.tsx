import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import DispatcherDeliveriesClient from "./DispatcherDeliveriesClient";

export default async function DispatcherMyDeliveriesPage() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = String(user?.role || "");

  if (!session) {
    redirect("/login");
  }
  if (!["DISPATCHER", "ADMIN", "STAFF"].includes(role)) {
    redirect("/unauthorized");
  }

  return <DispatcherDeliveriesClient />;
}
