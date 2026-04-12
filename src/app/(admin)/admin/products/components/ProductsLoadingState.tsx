"use client";

import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function ProductsLoadingState({
  error,
  onRetry,
}: {
  error?: boolean;
  onRetry?: () => void;
}) {
  if (error) {
    return (
      <Card className="border-destructive/30 shadow-sm">
        <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertCircle className="h-5 w-5" />
          </div>
          <div className="space-y-1">
            <p className="font-medium text-foreground">Failed to load products</p>
            <p className="text-sm text-muted-foreground">
              The catalog data could not be loaded. Retry the request to continue.
            </p>
          </div>
          {onRetry ? (
            <Button type="button" variant="outline" onClick={onRetry}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry
            </Button>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading products...
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-80 w-full" />
    </div>
  );
}
