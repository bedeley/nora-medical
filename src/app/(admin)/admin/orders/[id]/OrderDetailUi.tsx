import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { chipToneBorderClass, chipToneClass, deliveryStatusTone } from "@/lib/status-chips";

export type OrderDetailTabId = "items" | "payments" | "returns" | "activity";

type OrderSectionTabsProps = {
  activeTab: OrderDetailTabId;
  onChange: (tab: OrderDetailTabId) => void;
};

type OrderKpiStripProps = {
  totalLabel: string;
  paidLabel: string;
  balanceLabel: string;
  balanceTone: "positive" | "warning";
  deliveryLabel: string;
  deliveryStatus: string;
};

type OrderTimelineCardProps = {
  events: Array<{ time: Date; label: string; detail?: string }>;
  formatDate: (value: Date) => string;
};

type OrderNotificationEstimateCardProps = {
  customerType?: "REGISTERED" | "WALK_IN";
  hasPaymentRecorded: boolean;
  hasStoreCreditIssued: boolean;
  deliveryStatus: string;
};

const tabs: Array<{ id: OrderDetailTabId; label: string; detail: string }> = [
  { id: "items", label: "Items", detail: "Delivery and fulfillment" },
  { id: "payments", label: "Payments", detail: "Receipts and ledger" },
  { id: "returns", label: "Returns", detail: "Credits and refunds" },
  { id: "activity", label: "Activity", detail: "Timeline and customer signals" },
];

export function OrderSectionTabs({
  activeTab,
  onChange,
}: OrderSectionTabsProps) {
  return (
    <div className="rounded-2xl border bg-card p-2">
      <div className="grid gap-2 md:grid-cols-4">
        {tabs.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChange(tab.id)}
              className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                active
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-background hover:border-foreground/30 hover:bg-muted/50"
              }`}
            >
              <div className="text-sm font-semibold">{tab.label}</div>
              <div
                className={`mt-1 text-xs ${
                  active ? "text-background/75" : "text-muted-foreground"
                }`}
              >
                {tab.detail}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function OrderKpiStrip({
  totalLabel,
  paidLabel,
  balanceLabel,
  balanceTone,
  deliveryLabel,
  deliveryStatus,
}: OrderKpiStripProps) {
  const deliveryTone = deliveryStatusTone(deliveryStatus);

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Card className="rounded-2xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">
            Order Total
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tracking-tight">{totalLabel}</p>
        </CardContent>
      </Card>
      <Card className="rounded-2xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">
            Paid to Date
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tracking-tight text-emerald-700">
            {paidLabel}
          </p>
        </CardContent>
      </Card>
      <Card className="rounded-2xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">
            Open Balance
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p
            className={`text-2xl font-semibold tracking-tight ${
              balanceTone === "warning" ? "text-amber-700" : "text-emerald-700"
            }`}
          >
            {balanceLabel}
          </p>
        </CardContent>
      </Card>
      <Card className="rounded-2xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">
            Delivery State
          </CardTitle>
        </CardHeader>
        <CardContent>
          <span
            className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium ${chipToneClass(
              deliveryTone,
            )} ${chipToneBorderClass(deliveryTone)}`}
          >
            {deliveryLabel}
          </span>
        </CardContent>
      </Card>
    </div>
  );
}

export function OrderTimelineCard({
  events,
  formatDate,
}: OrderTimelineCardProps) {
  if (events.length === 0) return null;

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">Activity Timeline</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3 text-xs">
          {events.map((event, idx) => (
            <li key={`${event.time.toISOString()}-${idx}`} className="flex items-start gap-2">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary/70" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{event.label}</span>
                </div>
                <p className="text-[11px] text-muted-foreground">{formatDate(event.time)}</p>
                {event.detail ? (
                  <p className="text-[11px] text-muted-foreground">{event.detail}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function OrderNotificationEstimateCard({
  customerType,
  hasPaymentRecorded,
  hasStoreCreditIssued,
  deliveryStatus,
}: OrderNotificationEstimateCardProps) {
  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">Customer Signal Estimate</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          This panel is an estimate based on order activity. It does not confirm whether an SMS or
          email was actually delivered.
        </p>
        {customerType === "WALK_IN" ? (
          <p className="text-xs text-muted-foreground">
            Walk-in sale. Customer notifications are usually not sent.
          </p>
        ) : (
          <ul className="space-y-2 text-xs">
            <li className="flex items-start gap-2">
              <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-muted" />
              <span>
                <span className="font-medium">Order confirmation</span>: not verified from a send log.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span
                className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
                  hasPaymentRecorded ? "bg-green-500" : "bg-muted"
                }`}
              />
              <span>
                <span className="font-medium">Payment updates</span>:{" "}
                {hasPaymentRecorded ? "likely sent after at least one payment." : "no payment-linked signal detected."}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span
                className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
                  hasStoreCreditIssued ? "bg-green-500" : "bg-muted"
                }`}
              />
              <span>
                <span className="font-medium">Return credit updates</span>:{" "}
                {hasStoreCreditIssued ? "likely issued after a return." : "no store-credit signal detected."}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span
                className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
                  deliveryStatus === "DELIVERED" ||
                  deliveryStatus === "PARTIALLY_DELIVERED" ||
                  deliveryStatus === "RETURNED"
                    ? "bg-green-500"
                    : "bg-muted"
                }`}
              />
              <span>
                <span className="font-medium">Delivery updates</span>:{" "}
                {deliveryStatus === "DELIVERED" ||
                deliveryStatus === "PARTIALLY_DELIVERED" ||
                deliveryStatus === "RETURNED"
                  ? "likely attempted after the latest delivery change."
                  : "no delivery signal yet."}
              </span>
            </li>
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function EmptyTabState({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <Card className="rounded-2xl border-dashed">
      <CardContent className="flex flex-col gap-3 py-10 text-center">
        <div>
          <p className="text-sm font-semibold">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{body}</p>
        </div>
        {actionLabel && onAction ? (
          <div>
            <Button type="button" variant="outline" onClick={onAction}>
              {actionLabel}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
