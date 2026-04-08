"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { chipToneClass } from "@/lib/status-chips";
import type { ReactNode } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { ADMIN_NAV_ITEMS, ADMIN_NAV_ESSENTIAL_HREFS, ADMIN_NAV_GROUPS } from "@/lib/admin-nav";
import { CommandPalette, CommandPaletteTrigger } from "@/components/admin/CommandPalette";
import { AdminBreadcrumb } from "@/components/admin/AdminBreadcrumb";
type AdminRole = "ADMIN" | "STAFF" | "ACCOUNTANT";

export default function AdminGroupLayout({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = usePathname();
  const isOtcRelatedPage =
    (typeof pathname === "string" && pathname.startsWith("/admin/orders/otc")) ||
    (typeof pathname === "string" && pathname.startsWith("/admin/otc/shift-close"));
  const isReceipt = typeof pathname === "string" && pathname.includes("/receipt");
  const { data: session } = useSession();
  const role = (session?.user as { role?: AdminRole } | undefined)?.role;
  const isAdmin = role === "ADMIN";
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileNavQuery, setMobileNavQuery] = useState("");
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const [healthSummary, setHealthSummary] = useState<{
    paymentMismatches: number;
    orderBalanceMismatches: number;
    stockMismatches: number;
    legacyAutoApply: number;
    ledgerMismatches?: number;
    missingPostings?: Record<string, number>;
    podCompliance7d?: {
      delivered: number;
      podCaptured: number;
      podMissing: number;
      podMissingRatePct: number;
      thresholdPct: number;
      minDelivered: number;
      alert: boolean;
    };
  } | null>(null);
  const [otcShiftStatus, setOtcShiftStatus] = useState<{
    isOpen: boolean;
    isClosed: boolean;
    day: string;
    canOpenNow?: boolean;
  } | null>(null);

  useEffect(() => {
    if (!isOtcRelatedPage) {
      setOtcShiftStatus(null);
      return;
    }
    let active = true;
    const fetchOtcShiftStatus = async () => {
      try {
        const res = await fetch("/api/admin/otc/shift-close/status");
        const j = await res.json().catch(() => null);
        if (active && res.ok) setOtcShiftStatus(j);
      } catch {
        // ignore OTC shift status errors
      }
    };
    (async () => {
      try {
        const res = await fetch("/api/admin/health/summary");
        const j = await res.json().catch(() => null);
        if (active && res.ok) setHealthSummary(j);
      } catch {
        // ignore banner load errors
      }
    })();
    (async () => {
      try {
        await fetch("/api/admin/health/alerts", { method: "POST" });
      } catch {
        // ignore alert errors
      }
    })();
    void fetchOtcShiftStatus();
    const onShiftChanged = () => {
      void fetchOtcShiftStatus();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("otc-shift-status-changed", onShiftChanged);
    }
    return () => {
      active = false;
      if (typeof window !== "undefined") {
        window.removeEventListener("otc-shift-status-changed", onShiftChanged);
      }
    };
  }, [isOtcRelatedPage]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const selector = "[data-slot='table-container'], .overflow-x-auto, .overflow-auto";

    const markScrollable = () => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
      for (const node of nodes) {
        const isScrollable = node.scrollWidth > node.clientWidth + 1;
        if (isScrollable) {
          node.classList.add("drag-scroll-enabled");
        } else {
          node.classList.remove("drag-scroll-enabled");
        }
      }
    };

    let observer: MutationObserver | null = null;
    let hydrationSafeReady = false;
    let rafId = 0;
    let startTimer: number | null = null;

    const startEnhancements = () => {
      if (hydrationSafeReady) return;
      hydrationSafeReady = true;
      markScrollable();
      observer = new MutationObserver(() => {
        markScrollable();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    };

    const onResize = () => {
      if (!hydrationSafeReady) return;
      markScrollable();
    };
    window.addEventListener("resize", onResize);

    const scheduleStart = () => {
      if (startTimer) return;
      // Delay slightly so nested page segments complete hydration before DOM mutation.
      startTimer = window.setTimeout(() => {
        rafId = window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => startEnhancements());
        });
      }, 250);
    };

    if (document.readyState === "complete") {
      scheduleStart();
    } else {
      const onLoad = () => scheduleStart();
      window.addEventListener("load", onLoad, { once: true });
      return () => {
        window.removeEventListener("resize", onResize);
        window.removeEventListener("load", onLoad);
        if (observer) observer.disconnect();
        if (rafId) window.cancelAnimationFrame(rafId);
        if (startTimer) window.clearTimeout(startTimer);
      };
    }

    return () => {
      window.removeEventListener("resize", onResize);
      if (observer) observer.disconnect();
      if (rafId) window.cancelAnimationFrame(rafId);
      if (startTimer) window.clearTimeout(startTimer);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const header = document.querySelector<HTMLElement>("[data-admin-nav='1']");
    if (!header) return;
    const applyOffset = () => {
      const height = Math.ceil(header.getBoundingClientRect().height);
      document.documentElement.style.setProperty("--admin-nav-height", `${height}px`);
    };
    applyOffset();
    const observer = new ResizeObserver(() => applyOffset());
    observer.observe(header);
    window.addEventListener("resize", applyOffset);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", applyOffset);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const state = {
      active: false,
      moved: false,
      startX: 0,
      startLeft: 0,
      container: null as HTMLElement | null,
    };

    const isInteractive = (target: HTMLElement | null) =>
      Boolean(
        target?.closest(
          "a,button,input,textarea,select,option,label,[role='button'],[role='menuitem'],[data-no-drag-scroll='1']",
        ),
      );

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (!target || isInteractive(target)) return;

      const container = target.closest(
        "[data-slot='table-container'], .overflow-x-auto, .overflow-auto",
      ) as HTMLElement | null;
      if (!container) return;
      if (container.getAttribute("data-slot") === "table-container") return;
      if (container.scrollWidth <= container.clientWidth + 1) return;

      state.active = true;
      state.moved = false;
      state.startX = event.clientX;
      state.startLeft = container.scrollLeft;
      state.container = container;
      container.classList.add("cursor-grabbing", "select-none");
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!state.active || !state.container) return;
      const deltaX = event.clientX - state.startX;
      if (Math.abs(deltaX) > 3) state.moved = true;
      state.container.scrollLeft = state.startLeft - deltaX;
      event.preventDefault();
    };

    const stop = () => {
      if (!state.active) return;
      state.active = false;
      if (state.container) {
        state.container.classList.remove("cursor-grabbing", "select-none");
      }
      state.container = null;
    };

    const onClickCapture = (event: MouseEvent) => {
      if (!state.moved) return;
      event.preventDefault();
      event.stopPropagation();
      state.moved = false;
    };

    document.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mousemove", onMouseMove, { passive: false });
    window.addEventListener("mouseup", stop);
    document.addEventListener("click", onClickCapture, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", stop);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, []);

  const { data: pinnedPref } = useClientQuery<{ value: string[] | null }>({
    queryKey: ["admin", "navbar-links"],
    queryFn: () => fetch("/api/admin/preferences?key=admin.navbar.links").then((r) => r.json()),
    enabled: Boolean(role),
  });
  const { data: orderPref } = useClientQuery<{ value: string[] | null }>({
    queryKey: ["admin", "navbar-order"],
    queryFn: () => fetch("/api/admin/preferences?key=admin.navbar.order").then((r) => r.json()),
    enabled: Boolean(role),
  });
  const pinnedHrefs = useMemo(() => {
    const value = pinnedPref?.value;
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  }, [pinnedPref]);
  const orderHrefs = useMemo(() => {
    const value = orderPref?.value;
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  }, [orderPref]);

  const navItems = useMemo(() => {
    const byHref = new Map(ADMIN_NAV_ITEMS.map((item) => [item.href, item]));
    const baseHrefs = [
      ...ADMIN_NAV_ESSENTIAL_HREFS,
      ...pinnedHrefs.filter((href) => !ADMIN_NAV_ESSENTIAL_HREFS.includes(href)),
    ];
    const baseItems = baseHrefs
      .map((href) => byHref.get(href))
      .filter((item): item is (typeof ADMIN_NAV_ITEMS)[number] => Boolean(item));
    if (orderHrefs.length === 0) return baseItems;
    const orderIndex = new Map(orderHrefs.map((href, index) => [href, index]));
    const baseIndex = new Map(baseHrefs.map((href, index) => [href, index]));
    return [...baseItems].sort((a, b) => {
      const aOrder = orderIndex.has(a.href) ? orderIndex.get(a.href)! : 1000 + (baseIndex.get(a.href) ?? 0);
      const bOrder = orderIndex.has(b.href) ? orderIndex.get(b.href)! : 1000 + (baseIndex.get(b.href) ?? 0);
      return aOrder - bOrder;
    });
  }, [pinnedHrefs, orderHrefs]);

  const visibleNav = useMemo(() => {
    if (!role) return [];
    return navItems.filter((item) => item.roles.includes(role));
  }, [navItems, role]);
  const allRoleNav = useMemo(() => {
    if (!role) return [];
    return ADMIN_NAV_ITEMS.filter((item) => item.roles.includes(role));
  }, [role]);
  const currentNavLabel =
    visibleNav.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))?.label || "Admin";
  const mobileQuery = mobileNavQuery.trim().toLowerCase();
  const mobileQuickNavItems = mobileQuery
    ? visibleNav.filter((item) => item.label.toLowerCase().includes(mobileQuery))
    : visibleNav;
  const mobileAllNavItems = useMemo(() => {
    const quickSet = new Set(visibleNav.map((item) => item.href));
    const filtered = mobileQuery
      ? allRoleNav.filter((item) => item.label.toLowerCase().includes(mobileQuery))
      : allRoleNav;
    const seen = new Set<string>();
    return filtered.filter((item) => {
      if (quickSet.has(item.href)) return false;
      if (seen.has(item.href)) return false;
      seen.add(item.href);
      return true;
    });
  }, [allRoleNav, mobileQuery, visibleNav]);

  useEffect(() => {
    setMobileMenuOpen(false);
    setOpenGroup(null);
  }, [pathname]);

  useEffect(() => {
    if (!openGroup) return;
    const handler = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setOpenGroup(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openGroup]);

  if (isReceipt) {
    return <>{children}</>;
  }

  return (
    <div data-slot="admin-page" className="overflow-x-hidden">
      <header
        data-admin-nav="1"
        className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 print:hidden"
      >
        <div className="container mx-auto py-2">
          <div className="md:hidden flex items-center justify-between gap-2 px-2">
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">Admin</div>
              <div className="text-sm font-medium truncate">{currentNavLabel}</div>
            </div>
            <button
              type="button"
              className="rounded border px-3 py-1.5 text-sm"
              onClick={() => setMobileMenuOpen((v) => !v)}
              aria-expanded={mobileMenuOpen}
              aria-label="Toggle admin menu"
            >
              {mobileMenuOpen ? "Close" : "Menu"}
            </button>
          </div>

          {mobileMenuOpen ? (
            <div className="md:hidden mt-2 mx-2 rounded-md border bg-background shadow-sm">
              <div className="p-2 border-b">
                <input
                  type="text"
                  value={mobileNavQuery}
                  onChange={(e) => setMobileNavQuery(e.target.value)}
                  placeholder="Search admin pages"
                  className="w-full rounded border px-2 py-1.5 text-sm"
                />
              </div>
              <nav className="max-h-[58vh] overflow-auto p-2 grid grid-cols-1 gap-1 text-sm">
                {visibleNav.length === 0 ? (
                  <div className="text-xs text-muted-foreground px-2 py-1">
                    {isAdmin ? "Loading navigation..." : "You do not have access to the admin portal."}
                  </div>
                ) : mobileQuickNavItems.length === 0 && mobileAllNavItems.length === 0 ? (
                  <div className="text-xs text-muted-foreground px-2 py-1">No matching pages.</div>
                ) : (
                  <>
                    <div className="px-2 pt-1 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                      Quick Links
                    </div>
                    {mobileQuickNavItems.length === 0 ? (
                      <div className="text-xs text-muted-foreground px-2 py-1">No quick links match search.</div>
                    ) : (
                      mobileQuickNavItems.map((item) => {
                        const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
                        return (
                          <Link
                            key={`quick-${item.href}`}
                            href={item.href}
                            className={`rounded px-2 py-2 ${isActive ? "bg-muted font-medium" : "hover:bg-muted/60"}`}
                            onClick={() => setMobileMenuOpen(false)}
                          >
                            {item.label}
                          </Link>
                        );
                      })
                    )}

                    <div className="my-1 border-t" />
                    <div className="px-2 pt-1 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                      All Admin Pages
                    </div>
                    {mobileAllNavItems.map((item) => {
                      const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
                      return (
                        <Link
                          key={`all-${item.href}`}
                          href={item.href}
                          className={`rounded px-2 py-2 ${isActive ? "bg-muted font-medium" : "hover:bg-muted/60"}`}
                          onClick={() => setMobileMenuOpen(false)}
                        >
                          {item.label}
                        </Link>
                      );
                    })}
                  </>
                )}
              </nav>
            </div>
          ) : null}

          <nav ref={navRef} className="hidden md:flex items-center gap-0.5 text-sm px-2 h-10">
            <span className="text-xs font-semibold text-muted-foreground pr-3 mr-1 border-r shrink-0">
              Admin
            </span>
            {!role ? (
              <span className="text-xs text-muted-foreground">
                {isAdmin ? "Loading navigation..." : "You do not have access to the admin portal."}
              </span>
            ) : (
              ADMIN_NAV_GROUPS.map((group) => {
                const groupItems = group.hrefs
                  .map((href) => ADMIN_NAV_ITEMS.find((i) => i.href === href))
                  .filter(
                    (item): item is (typeof ADMIN_NAV_ITEMS)[number] =>
                      Boolean(item) && item!.roles.includes(role),
                  );
                if (groupItems.length === 0) return null;
                const isGroupActive = groupItems.some(
                  (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
                );
                if (groupItems.length === 1) {
                  return (
                    <Link
                      key={group.label}
                      href={groupItems[0].href}
                      className={`px-3 py-1.5 rounded text-sm whitespace-nowrap transition-colors ${
                        isGroupActive
                          ? "bg-muted font-medium text-foreground"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      }`}
                    >
                      {group.label}
                    </Link>
                  );
                }
                return (
                  <div key={group.label} className="relative">
                    <button
                      type="button"
                      onClick={() => setOpenGroup(openGroup === group.label ? null : group.label)}
                      className={`flex items-center gap-1 px-3 py-1.5 rounded text-sm whitespace-nowrap transition-colors ${
                        isGroupActive
                          ? "bg-muted font-medium text-foreground"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      }`}
                    >
                      {group.label}
                      <svg
                        className={`h-3 w-3 shrink-0 transition-transform duration-150 ${openGroup === group.label ? "rotate-180" : ""}`}
                        viewBox="0 0 12 12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M2 4l4 4 4-4" />
                      </svg>
                    </button>
                    {openGroup === group.label && (
                      <div className="absolute top-full left-0 mt-1 min-w-[200px] rounded-md border bg-background shadow-md z-50 py-1">
                        {groupItems.map((item) => {
                          const isActive =
                            pathname === item.href || pathname.startsWith(`${item.href}/`);
                          return (
                            <Link
                              key={item.href}
                              href={item.href}
                              className={`block px-4 py-2 text-sm whitespace-nowrap transition-colors ${
                                isActive
                                  ? "bg-muted font-medium text-foreground"
                                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                              }`}
                              onClick={() => setOpenGroup(null)}
                            >
                              {item.label}
                            </Link>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
            <div className="ml-auto pl-2 shrink-0">
              <CommandPaletteTrigger />
            </div>
          </nav>
          <AdminBreadcrumb />
        </div>
      </header>
      {healthSummary &&
      (healthSummary.paymentMismatches > 0 ||
        healthSummary.orderBalanceMismatches > 0 ||
        healthSummary.stockMismatches > 0 ||
        healthSummary.legacyAutoApply > 0 ||
        (healthSummary.ledgerMismatches ?? 0) > 0 ||
        Boolean(healthSummary.podCompliance7d?.alert) ||
        (healthSummary.missingPostings &&
          Object.values(healthSummary.missingPostings).some((count) => count > 0))) ? (
        <div className={`border-b ${chipToneClass("warning")}`}>
          <div className="container mx-auto py-2 text-xs flex flex-wrap items-center gap-2">
            <span className="font-semibold">Health Check alert:</span>
            {healthSummary.paymentMismatches > 0 ? (
              <span>{healthSummary.paymentMismatches} payment mismatch(es)</span>
            ) : null}
            {healthSummary.orderBalanceMismatches > 0 ? (
              <span>{healthSummary.orderBalanceMismatches} balance mismatch(es)</span>
            ) : null}
            {healthSummary.stockMismatches > 0 ? (
              <span>{healthSummary.stockMismatches} stock mismatch(es)</span>
            ) : null}
            {(healthSummary.ledgerMismatches ?? 0) > 0 ? (
              <span>{healthSummary.ledgerMismatches} ledger mismatch(es)</span>
            ) : null}
            {healthSummary.missingPostings &&
            Object.values(healthSummary.missingPostings).some((count) => count > 0) ? (
              <span>ledger readiness issues</span>
            ) : null}
            {healthSummary.legacyAutoApply > 0 ? (
              <span>{healthSummary.legacyAutoApply} legacy auto-apply row(s)</span>
            ) : null}
            {healthSummary.podCompliance7d?.alert ? (
              <span>
                POD missing {healthSummary.podCompliance7d.podMissing}/
                {healthSummary.podCompliance7d.delivered} (
                {healthSummary.podCompliance7d.podMissingRatePct}%)
              </span>
            ) : null}
            <Link href="/admin/health" className="underline font-medium">
              Review now
            </Link>
          </div>
        </div>
      ) : null}
      {isOtcRelatedPage && otcShiftStatus && role && role !== "ACCOUNTANT" && !otcShiftStatus.isOpen ? (
        <div className={`border-b ${chipToneClass("warning")}`}>
          <div className="container mx-auto py-2 text-xs flex flex-wrap items-center gap-2">
            <span className="font-semibold">OTC Shift:</span>
            {otcShiftStatus.isClosed ? (
              <span>
                Closed for {otcShiftStatus.day}. New OTC sales require admin override.
              </span>
            ) : (
              <span>
                Not open for {otcShiftStatus.day}. Open shift before OTC sales.
              </span>
            )}
            <Link href="/admin/orders/otc" className="underline font-medium">
              Open OTC Sales
            </Link>
            <Link href="/admin/otc/shift-close" className="underline font-medium">
              Open Shift Close
            </Link>
          </div>
        </div>
      ) : null}
      <CommandPalette role={role} />
      {children}
      <style jsx global>{`
        .drag-scroll-enabled {
          position: relative;
        }

        .drag-scroll-enabled::after {
          content: "Drag to scroll";
          position: absolute;
          top: 6px;
          right: 8px;
          font-size: 11px;
          line-height: 1;
          padding: 4px 6px;
          border-radius: 9999px;
          background: rgba(17, 24, 39, 0.72);
          color: #fff;
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.18s ease;
          z-index: 20;
        }

        .drag-scroll-enabled:hover::after {
          opacity: 0.9;
        }
      `}</style>
    </div>
  );
}
