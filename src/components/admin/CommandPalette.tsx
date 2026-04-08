"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ADMIN_NAV_ITEMS } from "@/lib/admin-nav";

interface CommandPaletteProps {
  role: "ADMIN" | "STAFF" | "ACCOUNTANT" | undefined;
}

export function CommandPalette({ role }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const items = role ? ADMIN_NAV_ITEMS.filter((item) => item.roles.includes(role)) : [];

  const filtered = query.trim()
    ? items.filter(
        (item) =>
          item.label.toLowerCase().includes(query.toLowerCase()) ||
          item.href.toLowerCase().includes(query.toLowerCase()),
      )
    : items;

  // Open with Cmd+K / Ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Focus input on open; reset state
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  const navigate = useCallback(
    (href: string) => {
      close();
      router.push(href);
    },
    [close, router],
  );

  // Keyboard navigation within palette
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => {
          const next = Math.min(i + 1, filtered.length - 1);
          scrollActiveIntoView(next);
          return next;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => {
          const next = Math.max(i - 1, 0);
          scrollActiveIntoView(next);
          return next;
        });
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[activeIndex]) navigate(filtered[activeIndex].href);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, filtered, activeIndex, close, navigate]);

  // Reset active index when query changes
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function scrollActiveIntoView(index: number) {
    if (!listRef.current) return;
    const item = listRef.current.children[index] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4 bg-black/40"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-lg rounded-xl border bg-background shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <svg
            className="h-4 w-4 shrink-0 text-muted-foreground"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search admin pages…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Search admin pages"
          />
          <kbd className="hidden sm:inline-flex h-5 select-none items-center rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
            ESC
          </kbd>
        </div>

        {/* Results list */}
        <div ref={listRef} className="max-h-[min(60vh,360px)] overflow-y-auto p-2" role="listbox">
          {filtered.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">No pages found.</div>
          ) : (
            filtered.map((item, i) => (
              <button
                key={item.href}
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-left transition-colors ${
                  i === activeIndex ? "bg-muted text-foreground" : "hover:bg-muted/60 text-foreground"
                }`}
                onClick={() => navigate(item.href)}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <span className="flex-1 font-medium">{item.label}</span>
                <span className="text-xs text-muted-foreground truncate max-w-[160px]">{item.href}</span>
              </button>
            ))
          )}
        </div>

        {/* Footer hints */}
        <div className="border-t px-4 py-2 flex items-center gap-3 text-[11px] text-muted-foreground">
          <span>
            <kbd className="font-mono">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="font-mono">↵</kbd> open
          </span>
          <span>
            <kbd className="font-mono">Esc</kbd> close
          </span>
          <span className="ml-auto">
            <kbd className="font-mono">⌘K</kbd> / <kbd className="font-mono">Ctrl+K</kbd>
          </span>
        </div>
      </div>
    </div>
  );
}

/** Small trigger button to render in the nav bar */
export function CommandPaletteTrigger() {
  const open = () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    );
  };
  return (
    <button
      type="button"
      onClick={open}
      className="hidden md:inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
      aria-label="Open command palette"
    >
      <svg
        className="h-3 w-3"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.35-4.35" />
      </svg>
      <span>Search</span>
      <kbd className="font-mono text-[10px]">⌘K</kbd>
    </button>
  );
}
