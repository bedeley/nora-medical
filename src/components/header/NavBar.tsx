"use client";

import Link from "next/link";
import Image from "next/image";
import { useSession, signIn, signOut } from "next-auth/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ThemeToggle from "@/components/header/ThemeToggle";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  ShoppingCart,
  Phone,
  ChevronDown,
  Menu,
  X,
  Shield,
  BookOpen,
  Users,
  DollarSign,
  ClipboardList,
  GripVertical,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ADMIN_PHONE, ADMIN_PHONE_TEL } from "@/lib/config";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AuthenticatedUser } from "@/lib/auth";
import { ADMIN_NAV_ITEMS, ADMIN_NAV_ESSENTIAL_HREFS } from "@/lib/admin-nav";
type AdminRole = "ADMIN" | "STAFF" | "ACCOUNTANT" | "DISPATCHER";

export default function NavBar() {
  const { data: session } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    if (pathname !== "/products") {
      setSearchQuery("");
      return;
    }
    const params = new URLSearchParams(window.location.search);
    setSearchQuery(params.get("q") || "");
  }, [pathname, mounted]);

  useEffect(() => {
    if (!mounted) return;
    const original = document.body.style.overflow;
    if (mobileOpen) {
      document.body.style.overflow = "hidden";
      document.body.style.overflowX = "hidden";
      document.documentElement.style.overflowX = "hidden";
      document.documentElement.style.width = "100%";
    } else {
      document.body.style.overflow = original || "";
      document.body.style.overflowX = "";
      document.documentElement.style.overflowX = "";
      document.documentElement.style.width = "";
    }
    return () => {
      document.body.style.overflow = original;
      document.body.style.overflowX = "";
      document.documentElement.style.overflowX = "";
      document.documentElement.style.width = "";
    };
  }, [mobileOpen, mounted]);

  useEffect(() => {
    if (!mobileOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    closeButtonRef.current?.focus();
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileOpen]);

  const { data: cartData } = useQuery({
    queryKey: ["cart"],
    queryFn: () => fetch("/api/cart").then((r) => r.json()),
    enabled: !!session,
    // Avoid constant polling to prevent layout jitter across pages
    refetchInterval: false,
    staleTime: 15000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    placeholderData: { items: [], total: 0 },
  });

  const { data: guestCart } = useQuery({
    queryKey: ["guest-cart"],
    queryFn: async () => {
      if (typeof window === "undefined") return [];
      const mod = await import("@/lib/guest-cart");
      return mod.getGuestCart();
    },
    enabled: !session && mounted,
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });

  const itemCount = useMemo(() => {
    if (session) {
      return (cartData?.items || []).reduce(
        (sum: number, item: { quantity?: number | string }) =>
          sum + (Number(item.quantity) || 0),
        0,
      );
    }
    return (guestCart || []).reduce(
      (sum: number, item: { quantity?: number | string }) =>
        sum + (Number(item.quantity) || 0),
      0,
    );
  }, [session, cartData, guestCart]);

  const scheduleSearch = (value: string) => {
    setSearchQuery(value);
    if (!mounted) return;
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      const params =
        pathname === "/products"
          ? new URLSearchParams(window.location.search)
          : new URLSearchParams();
      if (value.trim()) {
        params.set("q", value.trim());
      } else {
        params.delete("q");
      }
      const query = params.toString();
      const href = `/products${query ? `?${query}` : ""}`;
      if (pathname === "/products") {
        router.replace(href);
      } else {
        router.push(href);
      }
    }, 250);
  };

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

  const role = (session?.user as AuthenticatedUser | undefined)?.role as AdminRole | undefined;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  const isDispatcher = role === "DISPATCHER";
  const isBackOffice = isAdmin || isStaff || isAccountant;
  const backOfficeLabel = isAdmin
    ? "Admin"
    : isStaff
    ? "Staff"
    : isAccountant
    ? "Accountant"
    : isDispatcher
    ? "Dispatcher"
    : "";
  const adminMenuItems = useMemo(() => ADMIN_NAV_ITEMS, []);
  const roleForAdminMenu: "ADMIN" | "STAFF" | "ACCOUNTANT" | undefined =
    role === "ADMIN" || role === "STAFF" || role === "ACCOUNTANT" ? role : undefined;
  const visibleAdminMenuItems = useMemo(
    () =>
      !roleForAdminMenu
        ? []
        : adminMenuItems.filter((item) => item.roles.includes(roleForAdminMenu)),
    [adminMenuItems, roleForAdminMenu],
  );
  const visibleAdminHrefSet = useMemo(
    () => new Set(visibleAdminMenuItems.map((item) => item.href)),
    [visibleAdminMenuItems],
  );
  const sortedAdminMenuItems = useMemo(
    () => [...visibleAdminMenuItems].sort((a, b) => a.label.localeCompare(b.label)),
    [visibleAdminMenuItems],
  );
  const [pinnedAdminHrefs, setPinnedAdminHrefs] = useState<string[]>([]);
  const { data: pinnedPref } = useQuery({
    queryKey: ["admin", "navbar-links"],
    queryFn: () => fetch("/api/admin/preferences?key=admin.navbar.links").then((r) => r.json()),
    enabled: isBackOffice,
  });
  const { data: orderPref } = useQuery({
    queryKey: ["admin", "navbar-order"],
    queryFn: () => fetch("/api/admin/preferences?key=admin.navbar.order").then((r) => r.json()),
    enabled: isBackOffice,
  });
  useEffect(() => {
    const prefValue = pinnedPref?.value;
    if (Array.isArray(prefValue)) {
      setPinnedAdminHrefs(prefValue.filter((v) => typeof v === "string"));
    } else {
      setPinnedAdminHrefs([]);
    }
  }, [pinnedPref]);

  const pinnedSet = useMemo(() => {
    const set = new Set<string>(ADMIN_NAV_ESSENTIAL_HREFS);
    for (const href of pinnedAdminHrefs) set.add(href);
    return set;
  }, [pinnedAdminHrefs]);

  const pinnedExtras = useMemo(
    () => pinnedAdminHrefs.filter((href) => !ADMIN_NAV_ESSENTIAL_HREFS.includes(href)),
    [pinnedAdminHrefs],
  );

  const baseNavbarHrefs = useMemo(
    () =>
      [...ADMIN_NAV_ESSENTIAL_HREFS, ...pinnedExtras].filter((href) =>
        visibleAdminHrefSet.has(href),
      ),
    [pinnedExtras, visibleAdminHrefSet],
  );

  const buildNavbarOrder = (prefValue: unknown, baseHrefs: string[]) => {
    const baseSet = new Set(baseHrefs);
    const normalized = Array.isArray(prefValue)
      ? prefValue.filter((href) => typeof href === "string" && baseSet.has(href))
      : [];
    const missing = baseHrefs.filter((href) => !normalized.includes(href));
    return [...normalized, ...missing];
  };

  const [navbarOrder, setNavbarOrder] = useState<string[]>([]);
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);
  const [orderOpen, setOrderOpen] = useState(false);
  const [orderDragHref, setOrderDragHref] = useState<string | null>(null);
  const [orderDragOverHref, setOrderDragOverHref] = useState<string | null>(null);
  const [orderPointerActive, setOrderPointerActive] = useState(false);
  const orderPointerIdRef = useRef<number | null>(null);
  const orderPointerElRef = useRef<HTMLElement | null>(null);

  const desiredNavbarOrder = useMemo(() => {
    if (orderOverride) return orderOverride;
    return buildNavbarOrder(orderPref?.value, baseNavbarHrefs);
  }, [orderPref?.value, baseNavbarHrefs, orderOverride]);
  const sameOrder = (a: string[], b: string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);

  useEffect(() => {
    if (sameOrder(navbarOrder, desiredNavbarOrder)) return;
    setNavbarOrder(desiredNavbarOrder);
  }, [desiredNavbarOrder, navbarOrder]);
  useEffect(() => {
    if (!orderOverride) return;
    const fromPref = buildNavbarOrder(orderPref?.value, baseNavbarHrefs);
    if (sameOrder(orderOverride, fromPref)) {
      setOrderOverride(null);
    }
  }, [orderOverride, orderPref?.value, baseNavbarHrefs]);

  const navbarOrderItems = useMemo(
    () =>
      navbarOrder
        .map((href) => adminMenuItems.find((item) => item.href === href))
        .filter((item): item is (typeof adminMenuItems)[number] => Boolean(item)),
    [navbarOrder, adminMenuItems],
  );

  const togglePinned = async (href: string) => {
    const isEssential = ADMIN_NAV_ESSENTIAL_HREFS.includes(href);
    if (isEssential) return;
    const next = pinnedSet.has(href)
      ? pinnedAdminHrefs.filter((item) => item !== href)
      : [...pinnedAdminHrefs, href];
    setPinnedAdminHrefs(next);
    try {
      await fetch("/api/admin/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "admin.navbar.links", value: next }),
      });
    } catch {
      // best-effort; UI already updated
    }
  };

  const saveNavbarOrder = useCallback(async (next: string[]) => {
    queryClient.setQueryData(["admin", "navbar-order"], { value: next });
    try {
      await fetch("/api/admin/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "admin.navbar.order", value: next }),
      });
    } catch {
      // best-effort
    }
  }, [queryClient]);

  const reorderNavbar = useCallback(async (fromHref: string, toHref: string) => {
    if (fromHref === toHref) return;
    const fromIndex = navbarOrder.indexOf(fromHref);
    const toIndex = navbarOrder.indexOf(toHref);
    if (fromIndex === -1 || toIndex === -1) return;
    const next = [...navbarOrder];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setNavbarOrder(next);
    setOrderOverride(next);
    await saveNavbarOrder(next);
  }, [navbarOrder, saveNavbarOrder]);

  const handleOrderPointerDown = (event: React.PointerEvent, href: string) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setOrderDragHref(href);
    setOrderPointerActive(true);
    orderPointerIdRef.current = event.pointerId;
    orderPointerElRef.current = event.currentTarget as HTMLElement;
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!orderPointerActive) return;
    const handlePointerMove = (event: PointerEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const row = target?.closest?.("[data-order-item]");
      const next = row?.getAttribute?.("data-order-item") || null;
      setOrderDragOverHref(next);
    };
    const handlePointerUp = () => {
      if (orderDragHref && orderDragOverHref) {
        reorderNavbar(orderDragHref, orderDragOverHref);
      }
      if (orderPointerElRef.current && orderPointerIdRef.current !== null) {
        try {
          orderPointerElRef.current.releasePointerCapture(orderPointerIdRef.current);
        } catch {
          // ignore
        }
      }
      setOrderDragHref(null);
      setOrderDragOverHref(null);
      setOrderPointerActive(false);
      orderPointerIdRef.current = null;
      orderPointerElRef.current = null;
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [orderPointerActive, orderDragHref, orderDragOverHref, reorderNavbar]);

  const resetOrder = async () => {
    const next = buildNavbarOrder([], baseNavbarHrefs);
    setNavbarOrder(next);
    setOrderOverride(next);
    await saveNavbarOrder(next);
  };

  const resetPinned = async () => {
    setPinnedAdminHrefs([]);
    try {
      await fetch("/api/admin/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "admin.navbar.links", value: [] }),
      });
    } catch {
      // best-effort
    }
  };
  const onHome = pathname === "/";
  const showPublicHomeActions = !session && onHome;

  const isCurrent = (href: string) =>
    typeof pathname === "string" &&
    (pathname === href || pathname.startsWith(`${href}/`));

  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex items-center gap-3 py-2 px-4 relative min-w-0 max-[360px]:gap-2 max-[360px]:px-3">
        <Link
          href="/"
          aria-label="Noralls Medical Supplies home"
          className="flex items-center gap-2 flex-shrink-0 min-w-0"
        >
          <Image
            src="/logo.svg"
            alt=""
            width={140}
            height={40}
            sizes="(max-width: 360px) 90px, (max-width: 640px) 110px, 140px"
            className="h-7 w-auto sm:h-8 max-[360px]:h-6"
            priority
          />
          <span className="hidden sm:inline text-sm font-semibold tracking-tight">
            Noralls Medical Supplies
          </span>
        </Link>
        {/* Desktop navigation */}
        <div
          className={`ml-auto hidden lg:flex items-center gap-4 min-w-0 ${
            mobileOpen ? "opacity-0 pointer-events-none" : ""
          }`}
        >
          <Link
            href="/products"
            className={`text-sm font-medium hover:underline whitespace-nowrap ${
              isCurrent("/products") ? "text-primary font-semibold" : ""
            }`}
          >
            Products
          </Link>
          <Link
            href="/about"
            className={`text-sm font-medium hover:underline whitespace-nowrap ${
              isCurrent("/about") ? "text-primary font-semibold" : ""
            }`}
          >
            About
          </Link>
          <form
            action="/products"
            method="GET"
            className="hidden lg:flex items-center"
            onSubmit={(event) => {
              event.preventDefault();
              scheduleSearch(searchQuery);
            }}
          >
            <Input
              type="search"
              name="q"
              placeholder="Search products…"
              aria-label="Search products"
              className="w-44 xl:w-60 text-xs"
              value={searchQuery}
              onChange={(event) => scheduleSearch(event.target.value)}
            />
          </form>
          <a
            href={ADMIN_PHONE_TEL}
            className="flex flex-shrink-0 items-center text-sm font-medium gap-1"
          >
            <Phone className="h-4 w-4" /> {ADMIN_PHONE}
          </a>

                    {showPublicHomeActions ? (
            <>
              <Button
                asChild
                variant="outline"
                size="sm"
                className="whitespace-nowrap"
              >
                <Link href="/register">Create account</Link>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="whitespace-nowrap"
                onClick={() => signIn()}
              >
                Log in
              </Button>
            </>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex items-center gap-1 max-w-[200px] sm:max-w-none"
                >
                  <div className="flex items-center gap-2">
                    <span className="capitalize" suppressHydrationWarning>
                      {displayName}
                    </span>
                    {isBackOffice || isDispatcher ? (
                      <span className="px-2 py-0.5 bg-primary/10 text-primary text-xs rounded-full">
                        {backOfficeLabel}
                      </span>
                    ) : null}
                  </div>
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>

              <DropdownMenuContent align="end" className="w-52 px-1">
                {!session && (
                  <>
                    <DropdownMenuItem onClick={() => signIn()}>
                      Sign in
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/account">Create account</Link>
                    </DropdownMenuItem>
                  </>
                )}

                {session && (
                  <>
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      {session.user?.email}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <Link
                        href="/account"
                        className={
                          isCurrent("/account")
                            ? "font-semibold text-primary"
                            : ""
                        }
                      >
                        My account
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link
                        href="/orders"
                        className={
                          isCurrent("/orders")
                            ? "font-semibold text-primary"
                            : ""
                        }
                      >
                        Order history
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link
                        href="/account/balance"
                        className={
                          isCurrent("/account/balance")
                            ? "font-semibold text-primary"
                            : ""
                        }
                      >
                        My balance
                      </Link>
                    </DropdownMenuItem>
                    {isDispatcher ? (
                      <DropdownMenuItem asChild>
                        <Link href="/dispatch/my-deliveries">My deliveries</Link>
                      </DropdownMenuItem>
                    ) : null}
                    {isBackOffice && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="text-xs flex items-center gap-1 text-muted-foreground">
                          <Shield className="h-3 w-3" /> Admin Panel
                        </DropdownMenuLabel>
                        {sortedAdminMenuItems.map((item) => {
                          const icon =
                            item.icon === "users" ? (
                              <Users className="h-3 w-3 mr-2" />
                            ) : item.icon === "dollar" ? (
                              <DollarSign className="h-3 w-3 mr-2" />
                            ) : item.icon === "shield" ? (
                              <Shield className="h-3 w-3 mr-2" />
                            ) : item.icon === "book" ? (
                              <BookOpen className="h-3 w-3 mr-2" />
                            ) : (
                              <ClipboardList className="h-3 w-3 mr-2" />
                            );
                          return (
                            <DropdownMenuItem asChild key={item.href}>
                              <Link
                                href={item.href}
                                className={isCurrent(item.href) ? "font-semibold text-primary" : ""}
                              >
                                {icon} {item.label}
                              </Link>
                            </DropdownMenuItem>
                          );
                        })}
                        <DropdownMenuSeparator />
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>Navbar shortcuts</DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="w-[min(13rem,calc(100vw-2rem))] sm:w-52 max-h-[60vh] overflow-y-auto">
                            <DropdownMenuLabel className="text-xs text-muted-foreground">
                              Pin/unpin links
                            </DropdownMenuLabel>
                            {sortedAdminMenuItems.map((item) => {
                              const isEssential = ADMIN_NAV_ESSENTIAL_HREFS.includes(item.href);
                              const isPinned = pinnedSet.has(item.href);
                              return (
                                <DropdownMenuCheckboxItem
                                  key={`pin-${item.href}`}
                                  checked={isPinned}
                                  disabled={isEssential}
                                  onCheckedChange={() => togglePinned(item.href)}
                                >
                                  {item.label}
                                  {isEssential ? " (Essential)" : ""}
                                </DropdownMenuCheckboxItem>
                              );
                            })}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => setOrderOpen(true)}>
                              Customize navbar order
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={resetPinned}>
                              Reset navbar links
                            </DropdownMenuItem>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      </>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => signOut({ callbackUrl: "/" })}
                    >
                      Sign out
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <ThemeToggle />

          <Link
            href="/cart"
            className="relative flex items-center"
            aria-label={`Cart items: ${itemCount}`}
            suppressHydrationWarning
          >
            <ShoppingCart className="h-5 w-5" />
            <span
              className="absolute -top-2 left-3 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] leading-none font-semibold w-5 h-5"
              suppressHydrationWarning
            >
              {itemCount || 0}
            </span>
          </Link>
        </div>

        {/* Mobile actions (phone, theme toggle, account label, menu) */}
        <div className="flex flex-1 items-center justify-end gap-2 lg:hidden min-w-0 max-[360px]:gap-1.5">
          <a
            href={ADMIN_PHONE_TEL}
            className="hidden xs:flex flex-shrink-0 items-center text-sm font-medium gap-1"
          >
            <Phone className="h-4 w-4" /> {ADMIN_PHONE}
          </a>
          <ThemeToggle />
          {session ? (
            <div className="flex items-center gap-1 rounded border px-2 py-1.5 shrink-0">
              <span className="capitalize text-xs sm:text-sm whitespace-nowrap" suppressHydrationWarning>
                {displayName}
              </span>
              {isBackOffice || isDispatcher ? (
                <span className="inline-flex px-2 py-0.5 bg-primary/10 text-primary text-xs rounded-full">
                  {backOfficeLabel}
                </span>
              ) : null}
            </div>
          ) : null}
          <Button
            variant="outline"
            size="icon"
            onClick={() => setMobileOpen((prev) => !prev)}
            aria-label="Toggle navigation menu"
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav-menu"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
        </div>
      </div>

      {mobileOpen && mounted
        ? createPortal(
            <div
              id="mobile-nav-menu"
              className="fixed inset-0 z-50 bg-background text-foreground px-6 pt-24 pb-8 lg:hidden overflow-y-auto shadow-2xl"
              role="dialog"
              aria-modal="true"
              aria-label="Site navigation"
            >
              <div className="flex items-center justify-between mb-6">
                <p className="text-sm uppercase tracking-wide text-muted-foreground">Browse</p>
                <Button
                  ref={closeButtonRef}
                  variant="ghost"
                  size="icon"
                  onClick={() => setMobileOpen(false)}
                  aria-label="Close menu"
                >
                  <X className="h-5 w-5" />
                </Button>
              </div>
              <form
                action="/products"
                method="GET"
                className="mb-6"
                onSubmit={(event) => {
                  event.preventDefault();
                  scheduleSearch(searchQuery);
                }}
              >
                <Input
                  type="search"
                  name="q"
                  placeholder="Search products…"
                  aria-label="Search products"
                  className="w-full text-sm"
                  value={searchQuery}
                  onChange={(event) => scheduleSearch(event.target.value)}
                />
              </form>
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
      <Dialog open={orderOpen} onOpenChange={setOrderOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Customize navbar order</DialogTitle>
            <DialogDescription>
              Drag to reorder your admin navbar. Essentials and pinned links are both editable here.
            </DialogDescription>
          </DialogHeader>
          <div
            className="space-y-2"
          >
            {navbarOrderItems.length === 0 ? (
              <div className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                No navbar links yet. Pin a link from the dropdown first.
              </div>
            ) : (
              navbarOrderItems.map((item) => {
                const isDragging = orderDragHref === item.href;
                const isOver = orderDragOverHref === item.href;
                return (
                  <div
                    key={`order-dialog-${item.href}`}
                    data-order-item={item.href}
                    role="button"
                    tabIndex={0}
                    className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm ${
                      isOver ? "border-primary bg-primary/5" : "border-border"
                    } ${isDragging ? "bg-muted" : "bg-background"}`}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md border bg-muted text-muted-foreground cursor-grab select-none touch-none"
                        onPointerDown={(event) => handleOrderPointerDown(event, item.href)}
                      >
                        <GripVertical className="h-4 w-4" />
                      </span>
                      <span className="font-medium">{item.label}</span>
                      {ADMIN_NAV_ESSENTIAL_HREFS.includes(item.href) ? (
                        <span className="text-xs text-muted-foreground">Essential</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Pinned</span>
                      )}
                    </div>
                    {!ADMIN_NAV_ESSENTIAL_HREFS.includes(item.href) ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => togglePinned(item.href)}
                      >
                        Unpin
                      </Button>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="outline" onClick={resetOrder}>
              Reset order
            </Button>
            <Button type="button" onClick={() => setOrderOpen(false)}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </header>
  );
}
