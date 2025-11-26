"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import clsx from "clsx";
import { useEffect, useState } from "react";

interface PaginationProps {
  total: number;
  page: number;
  pageSize?: number;
}

export default function Pagination({
  total,
  page,
  pageSize = 12,
}: PaginationProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const [isMobile, setIsMobile] = useState(false);

  // ✅ Detect mobile view
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 480);
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  function changePage(newPage: number) {
    if (newPage === page || newPage < 1 || newPage > totalPages) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(newPage));
    router.push(`?${params.toString()}`, { scroll: true });
  }

  if (totalPages <= 1) return null;

  // ✅ Compute visible pages
  function getVisiblePages() {
    const maxButtons = 5;
    const pages: (number | string)[] = [];

    if (totalPages <= maxButtons) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      const start = Math.max(1, page - 1);
      const end = Math.min(totalPages, page + 1);

      if (start > 2) pages.push(1, "...");
      for (let i = start; i <= end; i++) pages.push(i);
      if (end < totalPages - 1) pages.push("...", totalPages);
    }

    return pages;
  }

  const visiblePages = getVisiblePages();

  // ✅ Compact mobile pagination
  if (isMobile) {
    return (
      <nav
        className="flex justify-center items-center gap-3 mt-6"
        aria-label="Pagination"
      >
        <Button
          variant="outline"
          size="sm"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => changePage(page - 1)}
        >
          <ChevronLeft className="h-4 w-4 mr-1" /> Prev
        </Button>

        <div className="text-sm font-medium select-none">
          Page {page} of {totalPages}
        </div>

        <Button
          variant="outline"
          size="sm"
          aria-label="Next page"
          disabled={page >= totalPages}
          onClick={() => changePage(page + 1)}
        >
          Next <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      </nav>
    );
  }

  // ✅ Desktop pagination
  return (
    <nav
      className="flex justify-center items-center gap-2 mt-6 flex-wrap"
      aria-label="Pagination"
    >
      <Button
        variant="outline"
        size="sm"
        aria-label="Previous page"
        disabled={page <= 1}
        onClick={() => changePage(page - 1)}
      >
        <ChevronLeft className="h-4 w-4 mr-1" /> Prev
      </Button>

      {visiblePages.map((p, idx) =>
        typeof p === "number" ? (
          <Button
            key={idx}
            variant={p === page ? "default" : "outline"}
            size="sm"
            className={clsx(
              "min-w-[36px]",
              p === page && "pointer-events-none"
            )}
            onClick={() => changePage(p)}
          >
            {p}
          </Button>
        ) : (
          <span
            key={idx}
            className="text-muted-foreground px-2 flex items-center"
            aria-hidden="true"
          >
            <MoreHorizontal className="h-4 w-4" />
          </span>
        )
      )}

      <Button
        variant="outline"
        size="sm"
        aria-label="Next page"
        disabled={page >= totalPages}
        onClick={() => changePage(page + 1)}
      >
        Next <ChevronRight className="h-4 w-4 ml-1" />
      </Button>
    </nav>
  );
}
