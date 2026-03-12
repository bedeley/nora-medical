import { redirect } from "next/navigation";

type ExpenseSourcePageProps = {
  params: Promise<{ expenseId: string }>;
};

export default async function ExpenseSourcePage({ params }: ExpenseSourcePageProps) {
  const { expenseId } = await params;
  const sourceId = String(expenseId || "").trim();
  if (!sourceId) {
    redirect("/admin/expenses");
  }
  const qs = new URLSearchParams({
    sourceId,
    q: sourceId,
  }).toString();
  redirect(`/admin/expenses?${qs}`);
}

