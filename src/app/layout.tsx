import "@/app/globals.css";
import { Suspense } from "react";
import { Inter } from "next/font/google";
import Providers from "@/components/Providers";
import type { Metadata, Viewport } from "next";

const inter = Inter({ subsets: ["latin"] });
const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://nora-hospital-supplies.local";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: {
    default: "Noralls Medical Supplies",
    template: "%s | Noralls Medical Supplies",
  },
  description: "Online medical supply store for hospitals, clinics, and practitioners.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Noralls Medical Supplies",
  },
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/logo.svg", type: "image/svg+xml" },
    ],
    apple: [
      { url: "/placeholder.png", sizes: "180x180" },
    ],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} bg-background text-foreground min-h-screen flex flex-col`}>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-0 focus:left-0 focus:px-4 focus:py-2 focus:bg-background focus:text-foreground focus:border focus:rounded-br-md focus:outline-none"
        >
          Skip to main content
        </a>
        <Suspense fallback={<div className="min-h-screen bg-background" />}>
          <Providers>
            <div id="main-content" tabIndex={-1} className="flex flex-col flex-1 outline-none">
              {children}
            </div>
          </Providers>
        </Suspense>
      </body>
    </html>
  );
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0f172a",
};
