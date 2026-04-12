export type OrderDeliveryStateItem = {
  quantity: number;
  deliveredQuantity?: number | null;
  returnedQuantity?: number | null;
};

export type OrderDeliveryStatus =
  | "NOT_DELIVERED"
  | "PARTIALLY_DELIVERED"
  | "DELIVERED"
  | "RETURNED";

export function getOrderDeliveryState(items: OrderDeliveryStateItem[]) {
  const normalized = items.map((item) => {
    const quantity = Number(item.quantity || 0);
    const delivered = Number(item.deliveredQuantity ?? 0);
    const returned = Number(item.returnedQuantity ?? 0);
    return {
      quantity,
      delivered,
      returned,
      outstandingDelivered: Math.max(0, delivered - returned),
    };
  });

  const anyDelivered = normalized.some((item) => item.delivered > 0);
  const allDelivered =
    normalized.length > 0 &&
    normalized.every((item) => item.delivered >= item.quantity);
  const hasOutstandingDeliveredUnits = normalized.some(
    (item) => item.outstandingDelivered > 0,
  );
  const fullyReturned = anyDelivered && allDelivered && !hasOutstandingDeliveredUnits;

  let status: OrderDeliveryStatus = "NOT_DELIVERED";
  if (fullyReturned) {
    status = "RETURNED";
  } else if (allDelivered) {
    status = "DELIVERED";
  } else if (anyDelivered) {
    status = "PARTIALLY_DELIVERED";
  }

  return {
    status,
    anyDelivered,
    allDelivered,
    fullyReturned,
    hasOutstandingDeliveredUnits,
    deliveredUnitCount: normalized.reduce((sum, item) => sum + item.delivered, 0),
    returnedUnitCount: normalized.reduce((sum, item) => sum + item.returned, 0),
    outstandingDeliveredUnitCount: normalized.reduce(
      (sum, item) => sum + item.outstandingDelivered,
      0,
    ),
  };
}
