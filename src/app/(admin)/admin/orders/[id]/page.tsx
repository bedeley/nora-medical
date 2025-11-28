export const dynamic = "force-dynamic";

import OrderDetails from "./OrderDetails";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }> | { id: string };
}) {
  const resolved = await params;
  return <OrderDetails orderId={resolved.id} />;
}
