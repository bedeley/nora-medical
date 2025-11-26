"use client";

import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import NavBar from "@/components/header/NavBar";
import Footer from "@/components/layout/Footer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const pathname = usePathname();
  const isReceiptRoute = typeof pathname === "string" && pathname.includes("/receipt");

  useEffect(() => {
    // Only register the service worker in production builds.
    // In dev, avoid caching pages so local changes and server restarts are always reflected.
    if (process.env.NODE_ENV !== "production") {
      return;
    }

    if ("serviceWorker" in navigator) {
      const register = () => {
        navigator.serviceWorker
          .register("/sw.js")
          .catch((error) => console.error("Service worker registration failed:", error));
      };
      window.addEventListener("load", register);
      return () => window.removeEventListener("load", register);
    }
    return undefined;
  }, []);

  return (
    <SessionProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {!isReceiptRoute && (
            <div className="print:hidden" data-chrome-nav>
              <NavBar />
            </div>
          )}
          <main className="container mx-auto px-4 py-6 print:p-0 print:m-0 print:w-full">
            {children}
          </main>
          {!isReceiptRoute && (
            <div className="print:hidden" data-chrome-footer>
              <Footer />
            </div>
          )}
          {/* Always render Toaster (screen-only) so actions like emailing receipts can show feedback */}
          <div className="print:hidden" data-chrome-toaster>
            <Toaster position="top-right" richColors />
          </div>
        </ThemeProvider>
        {/* Add React Query Devtools if installed */}
      </QueryClientProvider>
    </SessionProvider>
  );
}
