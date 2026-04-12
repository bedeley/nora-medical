"use client";

import { Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from "@/components/ui/pagination";

export function ProductsPagination({
  page,
  total,
  totalPages,
  onPageChange,
}: {
  page: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 pt-4 border-t text-sm">
      <span className="text-sm text-muted-foreground">
        Page {page} of {totalPages} ({total} total)
      </span>
      {totalPages > 1 ? (
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                onClick={(event) => {
                  event.preventDefault();
                  if (page > 1) onPageChange(page - 1);
                }}
              />
            </PaginationItem>
            {(() => {
              const pages: number[] = [];
              const start = Math.max(1, page - 2);
              const end = Math.min(totalPages, page + 2);

              for (let index = start; index <= end; index += 1) {
                pages.push(index);
              }

              return (
                <>
                  {start > 1 ? (
                    <PaginationItem>
                      <PaginationLink
                        onClick={(event) => {
                          event.preventDefault();
                          onPageChange(1);
                        }}
                      >
                        1
                      </PaginationLink>
                    </PaginationItem>
                  ) : null}
                  {start > 2 ? (
                    <PaginationItem>
                      <span className="px-2">...</span>
                    </PaginationItem>
                  ) : null}
                  {pages.map((pageNumber) => (
                    <PaginationItem key={pageNumber}>
                      <PaginationLink
                        isActive={pageNumber === page}
                        onClick={(event) => {
                          event.preventDefault();
                          onPageChange(pageNumber);
                        }}
                      >
                        {pageNumber}
                      </PaginationLink>
                    </PaginationItem>
                  ))}
                  {end < totalPages - 1 ? (
                    <PaginationItem>
                      <span className="px-2">...</span>
                    </PaginationItem>
                  ) : null}
                  {end < totalPages ? (
                    <PaginationItem>
                      <PaginationLink
                        onClick={(event) => {
                          event.preventDefault();
                          onPageChange(totalPages);
                        }}
                      >
                        {totalPages}
                      </PaginationLink>
                    </PaginationItem>
                  ) : null}
                </>
              );
            })()}
            <PaginationItem>
              <PaginationNext
                onClick={(event) => {
                  event.preventDefault();
                  if (page < totalPages) onPageChange(page + 1);
                }}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      ) : null}
    </div>
  );
}
