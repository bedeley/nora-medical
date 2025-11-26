"use client";

import { Input } from "@/components/ui/input";
import { useRouter, useSearchParams } from "next/navigation";
import { useDebouncedCallback } from "use-debounce";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export default function ProductFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLInputElement | null>(null);

  // ✅ Local state ensures controlled input and correct hydration
  const [query, setQuery] = useState(searchParams.get("q") || "");

  // ✅ Keep state in sync when navigating back/forward
  useEffect(() => {
    setQuery(searchParams.get("q") || "");
  }, [searchParams]);

  const handleSearch = useDebouncedCallback((term: string) => {
    const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
    if (term.trim()) params.set("q", term.trim());
    else params.delete("q");
    params.set("page", "1");
    router.push(`?${params.toString()}`);
  }, 400);

  // Type-to-focus: focus search when typing outside inputs
  useEffect(() => {
    const isTextInput = (el: EventTarget | null) => {
      if (!el || !(el as HTMLElement).tagName) return false;
      const tag = String((el as HTMLElement).tagName).toLowerCase();
      if (tag === "input" || tag === "textarea") return true;
      try {
        return !!(el as HTMLElement).isContentEditable;
      } catch {
        return false;
      }
    };
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const el = inputRef.current;
        if (el) {
          el.value = '';
          setQuery('');
          handleSearch('');
          try { el.setSelectionRange(0, 0); } catch {}
          e.preventDefault();
        }
        return;
      }
      if (isTextInput(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key;
      if (!k || k.length !== 1) return;
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const next = el.value.slice(0, start) + k + el.value.slice(end);
      el.value = next;
      setQuery(next);
      handleSearch(next);
      try {
        el.setSelectionRange(start + 1, start + 1);
      } catch {}
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, {
        capture: true,
      } as EventListenerOptions);
  }, [handleSearch]);



  return (
    <div className="flex items-center justify-center gap-2 mb-6">
      <div className="relative w-full max-w-md">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          ref={inputRef}
          autoFocus
          value={query}
          placeholder="Search products..."
          className="pl-9"
          onChange={(e) => {
            setQuery(e.target.value);
            handleSearch(e.target.value);
          }}
        />
      </div>
    </div>
  );
}
