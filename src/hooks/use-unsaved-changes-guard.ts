"use client";

import { useEffect } from "react";

type UseUnsavedChangesGuardOptions = {
  enabled: boolean;
  message: string;
};

export function useUnsavedChangesGuard({ enabled, message }: UseUnsavedChangesGuardOptions) {
  useEffect(() => {
    if (!enabled) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const anchor = target.closest("a") as HTMLAnchorElement | null;
      if (!anchor?.href) return;
      const url = new URL(anchor.href, window.location.origin);
      const sameOrigin = url.origin === window.location.origin;
      const samePath = url.pathname === window.location.pathname && url.search === window.location.search;
      if (!sameOrigin || samePath) return;
      const confirmed = window.confirm(message);
      if (!confirmed) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [enabled, message]);

  useEffect(() => {
    if (!enabled) return;
    const onPopState = () => {
      const allow = window.confirm(message);
      if (!allow) window.history.go(1);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [enabled, message]);
}

