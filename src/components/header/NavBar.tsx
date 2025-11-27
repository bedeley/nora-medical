"use client";

import Link from "next/link";
import Image from "next/image";
import { useSession, signIn, signOut } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import ThemeToggle from "@/components/header/ThemeToggle";
import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import {
  ShoppingCart,
  Phone,
  ChevronDown,
  Menu,
  X,
  Shield,
  Package,
  Users,
  DollarSign,
  ClipboardList,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ADMIN_PHONE, ADMIN_PHONE_TEL } from "@/lib/config";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import type { AuthenticatedUser } from "@/lib/auth";

export default function NavBar() {
  const { data: session } = useSession();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = mobileOpen ? "hidden" : original || "";
    return () => {
      document.body.style.overflow = original;
    };
  }, [mobileOpen, mounted]);

  const { data: cartData } = useQuery({
    queryKey: ["cart"],
    queryFn: () => fetch("/api/cart").then((r) => r.json()),
    // Avoid constant polling to prevent layout jitter across pages
    refetchInterval: false,
    staleTime: 15000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    placeholderData: { items: [], total: 0 },
  });

  const itemCount = (cartData?.items || []).reduce(
    (sum: number, item: { quantity?: number | string }) => sum + (Number(item.quantity) || 0),
    0
  );

  const displayName = session?.user?.name
    ? String(session.user.name).replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    : "Account";

  const mobileLinks = useMemo(
    () => [
      { href: "/products", label: "Products" },
      { href: "/cart", label: `Cart (${itemCount || 0})` },
      { href: "/account", label: session ? "Account & Balance" : "Create account" },
      { href: "/orders", label: "Order history" },
    ],
    [itemCount, session]
  );

  const isAdmin = (session?.user as AuthenticatedUser | undefined)?.role === "ADMIN";

  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex items-center gap-3 py-2 px-4 relative">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/logo.svg" alt="Nora' Hospital Supply" width={140} height={40} priority />
        </Link>

        <nav className={`ml-auto hidden md:flex items-center gap-3 min-w-0 ${mobileOpen ? "opacity-0 pointer-events-none" : ""}`}>
          <Link href="/products" className="text-sm font-medium hover:underline whitespace-nowrap">
            Products
          </Link>
          <Link
            href="/cart"
            className="text-sm font-medium relative flex items-center gap-1"
            aria-label={`Cart items: ${itemCount}`}
            suppressHydrationWarning
          >
            <ShoppingCart className="h-5 w-5" />
            <span
              className="absolute -top-2 left-4 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] leading-none font-semibold w-5 h-5"
              suppressHydrationWarning
            >
              {itemCount || 0}
            </span>
            Cart
          </Link>
        </nav>

        <div className="flex flex-1 items-center justify-end gap-2">
          <a href={ADMIN_PHONE_TEL} className="hidden sm:flex flex-shrink-0 items-center text-sm font-medium gap-1">
            <Phone className="h-4 w-4" /> {ADMIN_PHONE}
          </a>
          <ThemeToggle />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="flex items-center gap-1 max-w-[200px] sm:max-w-none">
              <div className="flex items-center gap-2">
                <span className="capitalize" suppressHydrationWarning>
                  {displayName}
                </span>
                {isAdmin && (
                  <span className="px-2 py-0.5 bg-primary/10 text-primary text-xs rounded-full">Admin</span>
                )}
                </div>
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="w-52">
              {!session && (
                <>
                  <DropdownMenuItem onClick={() => signIn()}>Sign in</DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/account">Create account</Link>
                  </DropdownMenuItem>
                </>
              )}

              {session && (
                <>
                  <DropdownMenuLabel className="text-xs text-muted-foreground">{session.user?.email}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link href="/account">My account</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/orders">Order history</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/account/balance">My balance</Link>
                  </DropdownMenuItem>
                  {isAdmin && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-xs flex items-center gap-1 text-muted-foreground">
                        <Shield className="h-3 w-3" /> Admin Panel
                      </DropdownMenuLabel>
                      <DropdownMenuItem asChild>
                        <Link href="/admin">
                          <Package className="h-3 w-3 mr-2" /> Dashboard
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/admin/products">
                          <Package className="h-3 w-3 mr-2" /> Products
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/admin/customers">
                          <Users className="h-3 w-3 mr-2" /> Customer Cart
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/admin/customer-accounts">
                          <Users className="h-3 w-3 mr-2" /> Customer Accounts
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/admin/orders">
                          <DollarSign className="h-3 w-3 mr-2" /> Orders/Payments
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/admin/inventory">
                          <ClipboardList className="h-3 w-3 mr-2" /> Inventory
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/admin/profit-loss">
                          <ClipboardList className="h-3 w-3 mr-2" /> Profit &amp; Loss
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/admin/purchases">
                          <ClipboardList className="h-3 w-3 mr-2" /> Purchases
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/admin/movements">
                          <ClipboardList className="h-3 w-3 mr-2" /> Movements
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/admin/expenses">
                          <DollarSign className="h-3 w-3 mr-2" /> Expenses
                        </Link>
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => signOut({ callbackUrl: "/" })}>Sign out</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="outline"
            size="icon"
            className="md:hidden"
            onClick={() => setMobileOpen((prev) => !prev)}
            aria-label="Toggle navigation menu"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
        </div>
      </div>

      {mobileOpen && mounted
        ? createPortal(
            <div className="fixed inset-0 z-50 bg-background text-foreground px-6 pt-24 pb-8 md:hidden overflow-y-auto shadow-2xl">
              <div className="flex items-center justify-between mb-6">
                <p className="text-sm uppercase tracking-wide text-muted-foreground">Browse</p>
                <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)} aria-label="Close menu">
                  <X className="h-5 w-5" />
                </Button>
              </div>
              <nav className="space-y-4 text-lg font-medium">
                {mobileLinks.map((link: (typeof mobileLinks)[number]) => (
                  <Link key={link.href} href={link.href} className="block" onClick={() => setMobileOpen(false)}>
                    {link.label}
                  </Link>
                ))}
              </nav>
              <div className="mt-8 space-y-3 text-sm">
                <a href={ADMIN_PHONE_TEL} className="flex items-center gap-2 text-primary font-semibold">
                  <Phone className="h-4 w-4" /> {ADMIN_PHONE}
                </a>
                {!session ? (
                  <Button className="w-full" onClick={() => signIn()}>
                    Sign in
                  </Button>
                ) : (
                  <Button variant="outline" className="w-full" onClick={() => signOut({ callbackUrl: "/" })}>
                    Sign out
                  </Button>
                )}
              </div>
            </div>,
            document.body
          )
        : null}
    </header>
  );
}
