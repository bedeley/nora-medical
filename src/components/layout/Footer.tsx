"use client";

import Link from "next/link";
import { ADMIN_PHONE, ADMIN_PHONE_TEL } from "@/lib/config";

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="mt-auto border-t bg-background/80 backdrop-blur">
      <div className="container mx-auto px-4 py-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-2">
          <p className="text-lg font-semibold">Noralls Medical Supplies</p>
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
            <Link href="/login" className="block">Sign in</Link>
            <Link href="/orders" className="block">Orders</Link>
          </div>
          <div className="space-y-1">
            <p className="font-medium text-foreground/80">Company</p>
            <Link href="/" className="block">Home</Link>
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
        <div className="container mx-auto px-4 py-4 text-xs text-muted-foreground flex flex-col items-center justify-center text-center">
          <span>© {year} Noralls Medical Supplies. All rights reserved.</span>
        </div>
      </div>
    </footer>
  );
}
