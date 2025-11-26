"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <section className="flex flex-col items-center justify-center text-center space-y-4 py-10">
      <AlertCircle className="h-10 w-10 text-red-500" />
      <h2 className="text-xl font-semibold">Something went wrong!</h2>
      <p className="text-sm text-muted-foreground max-w-md">
        We couldn’t load the products at this time. Please try again later.
      </p>
      <Button onClick={() => reset()}>Try again</Button>
    </section>
  );
}
