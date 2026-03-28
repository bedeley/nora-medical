"use client";

import { Children, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function EmployeePortalExpandableItems({
  children,
  itemLabel,
  initialCount = 4,
  step = 4,
  className = "grid gap-3",
}: {
  children: ReactNode;
  itemLabel: string;
  initialCount?: number;
  step?: number;
  className?: string;
}) {
  const items = useMemo(() => Children.toArray(children), [children]);
  const total = items.length;
  const [visibleCount, setVisibleCount] = useState(Math.min(initialCount, total || initialCount));
  const visibleItems = items.slice(0, visibleCount);
  const canShowMore = visibleCount < total;
  const canShowLess = total > initialCount && visibleCount > initialCount;

  return (
    <div className="space-y-3">
      <div className={className}>{visibleItems}</div>
      {total > initialCount ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>
            Showing {Math.min(visibleCount, total)} of {total} {itemLabel}
          </span>
          <div className="flex flex-wrap gap-2">
            {canShowMore ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setVisibleCount((current) => Math.min(total, current + step))}
              >
                Show more {itemLabel}
              </Button>
            ) : null}
            {canShowLess ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => setVisibleCount(initialCount)}>
                Show fewer {itemLabel}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
