import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <section className="container mx-auto py-8 space-y-6">
      <div className="max-w-5xl mx-auto text-center space-y-2">
        <Skeleton className="h-8 w-48 mx-auto" />
        <Skeleton className="h-4 w-96 mx-auto" />
        <Skeleton className="h-3 w-24 mx-auto" />
      </div>

      <div className="sticky top-0 z-20 bg-background/95 backdrop-blur border-y py-2 sm:py-4">
        <div className="max-w-5xl mx-auto py-2 sm:py-4 space-y-3">
          <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Skeleton className="h-10 w-full max-w-md" />
            <Skeleton className="h-10 w-full max-w-md sm:w-52" />
            <Skeleton className="h-10 w-full max-w-md sm:w-44" />
            <Skeleton className="h-10 w-full max-w-md sm:w-48" />
            <Skeleton className="h-10 w-full max-w-md sm:w-52" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-24 rounded-full" />
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-16" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="space-y-3">
              <Skeleton className="h-40 w-full rounded-md" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-8 w-full" />
            </div>
          ))}
        </div>
      </div>

      <div className="max-w-5xl mx-auto flex flex-col-reverse items-center justify-between gap-3 text-sm sm:flex-row">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-9 w-24" />
      </div>
    </section>
  );
}
