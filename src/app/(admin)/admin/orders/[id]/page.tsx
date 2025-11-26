export const dynamic = "force-dynamic";

import OrderDetails from "./OrderDetails";

export default function Page({ params }: { params: { id: string } }) {
  return <OrderDetails orderId={params.id} />;
}
