import { cn } from "@/lib/utils";

type SkeletonProps = React.HTMLAttributes<HTMLDivElement>;

/**
 * A lightweight animated placeholder used during data fetching/loading.
 * Compatible with shadcn/ui styling and Tailwind dark mode.
 */
export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-muted",
        "dark:bg-muted/40",
        className
      )}
      {...props}
    />
  );
}
