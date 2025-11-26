"use client";

import { Toaster as SonnerToaster } from "sonner";

/**
 * A wrapper around the `sonner` Toaster for consistent app-wide notifications.
 * The toast API is automatically available via `import { toast } from "sonner"`.
 */
export function Toaster() {
  return (
    <SonnerToaster
      position="top-right"
      richColors
      closeButton
      toastOptions={{
        style: {
          fontSize: "0.875rem",
          borderRadius: "0.5rem",
          padding: "0.75rem 1rem",
        },
      }}
    />
  );
}
