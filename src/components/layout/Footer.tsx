"use client";

import Link from "next/link";
import { ADMIN_PHONE, ADMIN_PHONE_TEL } from "@/lib/config";

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="mt-auto border-t bg-background/80 backdrop-blur">
      <div className="container mx-auto px-4 py-8 grid gap-6 md:grid-cols-3">
        <div className="space-y-2">
          <p className="text-lg font-semibold">Nora’ Hospital Supply</p>
          <p className="text-sm text-muted-foreground max-w-prose">
            Reliable medical and clinical supplies with fast local support.
          </p>
        </div>

        <nav className="grid grid-cols-3 gap-4 text-sm">
          <div className="space-y-1">
            <p className="font-medium text-foreground/80">Shop</p>
            <Link href="/products" className="block">Products</Link>
            <Link href="/cart" className="block">Cart</Link>
          </div>
          <div className="space-y-1">
            <p className="font-medium text-foreground/80">Account</p>
            <Link href="/account" className="block">Sign in</Link>
            <Link href="/orders" className="block">Orders</Link>
          </div>
          <div className="space-y-1">
            <p className="font-medium text-foreground/80">Company</p>
            <Link href="/about" className="block">About</Link>
            <Link href="/contact" className="block">Contact</Link>
            <Link href="/privacy" className="block">Privacy Policy</Link>
            <Link href="/terms" className="block">Terms of Service</Link>
          </div>
        </nav>

        <div className="space-y-2 text-sm">
          <p className="font-medium text-foreground/80">Support</p>
          <a href={ADMIN_PHONE_TEL} className="inline-flex items-center gap-2">
            <span>Call:</span>
            <span className="font-medium">{ADMIN_PHONE}</span>
          </a>
          <p className="text-xs text-muted-foreground">
            Mon–Fri, 9am–5pm local time
          </p>
        </div>
      </div>
      <div className="border-t">
        <div className="container mx-auto px-4 py-4 text-xs text-muted-foreground flex items-center justify-between">
          <span>© {year} Nora’ Hospital Supply. All rights reserved.</span>
          <span className="flex items-center gap-4">
            <Link href="/">Home</Link>
            <Link href="/about">About</Link>
            <Link href="/contact">Contact</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
          </span>
        </div>
      </div>
    </footer>
  );
}
