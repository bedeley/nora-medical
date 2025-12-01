import "@/app/globals.css";
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
        <Providers>{children}</Providers>
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
