"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type TooltipProps = {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom";
};

export function Tooltip({ content, children, side = "top" }: TooltipProps) {
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
    const tooltipMaxWidth = Math.min(360, viewportWidth - 24);
    const half = tooltipMaxWidth / 2;
    const clampedX = Math.max(12 + half, Math.min(centerX, viewportWidth - 12 - half));
    const top = side === "top" ? rect.top - 8 : rect.bottom + 8;
    setPos({ top, left: clampedX });
  }, [side]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const onScroll = () => updatePosition();
    const onResize = () => updatePosition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, side, updatePosition]);

  return (
    <span
      className="inline-flex align-middle"
      ref={triggerRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      tabIndex={0}
      aria-describedby="tooltip"
    >
      {children}
      {open && typeof window !== "undefined"
        ? createPortal(
            <div
              role="tooltip"
              className="pointer-events-none fixed z-[9999] -translate-x-1/2 rounded-md border bg-popover px-2 py-1 text-xs leading-snug text-popover-foreground shadow-md whitespace-normal text-left max-w-[min(90vw,22rem)]"
              style={{ top: pos.top, left: pos.left }}
            >
              {content}
            </div>,
            document.body
          )
        : null}
    </span>
  );
}
