"use client";

/* eslint-disable @next/next/no-img-element */

export const dynamic = "force-dynamic";

import { Suspense } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { MoreVertical, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { formatCurrency } from "@/lib/currency";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// Simple title case for names: uppercase first letter of each word
function toTitleCase(str: string) {
  return String(str || "").replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// Shared Zod schema (same as API)
// Accept absolute URLs (https://...) or a site path starting with '/'
const imageUrlOrPath = z
  .string()
  .refine(
    (val) => {
      try {
        new URL(val);
        return true;
      } catch {
        return typeof val === 'string' && val.startsWith('/');
      }
    },
    { message: "Upload an image or provide https://... or a site path like /images/..." }
  );

const productSchema = z.object({
  name: z.string().min(2, "Name is required"),
  description: z.string().min(5, "Description too short"),
  imageUrl: imageUrlOrPath,
  price: z.coerce.number().nonnegative("Invalid price"),
  // Cost is required and must be > 0 for new products
  cost: z.coerce.number().positive("Cost must be greater than 0"),
  stock: z.coerce.number().int().nonnegative("Invalid stock"),
});
// Allow relative paths (e.g., "/placeholder.png") or absolute URLs for editing
const urlOrPath = z
  .string()
  .refine(
    (val) => {
      try {
        // absolute URL ok
        new URL(val);
        return true;
      } catch {
        return typeof val === "string" && val.startsWith("/");
      }
    },
    { message: "Enter a valid URL or /path" }
  );

const productEditSchema = z.object({
  name: z.string().min(2).optional(),
  description: z.string().min(5).optional(),
  imageUrl: urlOrPath.optional(),
  price: z.coerce.number().nonnegative().optional(),
  stock: z.coerce.number().int().nonnegative().optional(),
  editReason: z.string().min(5, "Please add a brief reason for this change."),
});

function AdminProductsContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(""); // debounced value used for API/URL
  const [searchInput, setSearchInput] = useState(""); // immediate input value
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [editId, setEditId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Initialize includeArchived from URL
  useEffect(() => {
    const ia = searchParams.get("includeArchived");
    if (ia === "1" || ia === "true") setIncludeArchived(true);
    const q = searchParams.get("q");
    if (typeof q === "string") { setSearch(q); setSearchInput(q); }
    const p = Number(searchParams.get("page") || 1);
    const ps = Number(searchParams.get("pageSize") || 10);
    if (!Number.isNaN(p) && p > 0) setPage(p);
    if (!Number.isNaN(ps) && ps > 0) setPageSize(ps);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect state to URL (search, page, includeArchived)
  useEffect(() => {
    const params = new URLSearchParams();
    if (search) params.set("q", search); else params.delete("q");
    if (page && page > 1) params.set("page", String(page)); else params.delete("page");
    if (pageSize && pageSize !== 10) params.set("pageSize", String(pageSize)); else params.delete("pageSize");
    if (includeArchived) params.set("includeArchived", "1"); else params.delete("includeArchived");
    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [search, page, pageSize, includeArchived, pathname, router]);

  // Global key handler: when typing outside inputs, focus search and append the key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Esc clears search
      if (e.key === 'Escape') {
        const el = searchInputRef.current;
        if (el) {
          el.value = '';
          setSearchInput('');
          setPage(1);
          try { el.setSelectionRange(0, 0); } catch {}
          e.preventDefault();
        }
        return;
      }
      if (isTextInput(e.target)) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const key = e.key;
      if (!key || key.length !== 1) return;
      const el = searchInputRef.current;
      if (!el) return;
      el.focus();
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const next = el.value.slice(0, start) + key + el.value.slice(end);
      el.value = next;
      setSearchInput(next);
      setPage(1);
      try { el.setSelectionRange(start + 1, start + 1); } catch {}
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true } as EventListenerOptions);
  }, [setSearch]);

  // Debounce search input by ~2s before updating URL/API
  useEffect(() => {
    const id = setTimeout(() => {
      setSearch(searchInput);
    }, 2000);
    return () => clearTimeout(id);
  }, [searchInput]);

  const queryClient = useQueryClient();

  const getArchiveReason = (action: "archive" | "unarchive") => {
    const label = action === "archive" ? "archive" : "unarchive";
    const reason = window.prompt(`Please add a brief reason to ${label} this product (min 5 chars).`);
    if (reason == null) return null;
    const trimmed = reason.trim();
    if (trimmed.length < 5) {
      toast.error("Please add a brief reason for this change.");
      return null;
    }
    return trimmed;
  };

  const { data, error, isLoading } = useClientQuery({
    queryKey: ["admin","products", { search, page, pageSize, includeArchived }],
    queryFn: () => fetcher(`/api/products?q=${encodeURIComponent(search)}&page=${page}&pageSize=${pageSize}&sort=updatedAt&includeArchived=${includeArchived ? "1" : "0"}&startsWith=1`),
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Keyboard shortcut: '/' focuses the search input when not typing in an input already
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // If target isn't a text input/textarea/contenteditable, focus search
        const target = e.target as HTMLElement | null;
        const tag = (target?.tagName || '').toLowerCase();
        const isEditable =
          tag === 'input' ||
          tag === 'textarea' ||
          (target?.isContentEditable ?? false);
        if (!isEditable) {
          e.preventDefault();
          const el = searchInputRef.current;
          if (el) {
            el.focus();
            try { el.select(); } catch {}
          }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const products: AdminProduct[] = (data?.items || []) as AdminProduct[];
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / pageSize) || 1;

  return (
    <section className="p-6 space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-semibold">Admin - Products</h1>
        <AddProductDialog />
      </div>

      {/* Loading / error state */}
      {error || isLoading ? (
        <div className="text-sm text-muted-foreground">
          {error ? (
            <span className="text-red-500">Failed to load products.</span>
          ) : (
            <span>Loading products...</span>
          )}
        </div>
      ) : (
        <>
          {/* Search + Filters */}
          <div className="flex justify-between items-center gap-3">
            <Input
              placeholder="Search products..."
              className="w-64"
              value={searchInput}
              ref={searchInputRef}
              autoFocus
              onChange={(e) => {
                setSearchInput(e.target.value);
                setPage(1);
              }}
            />
            <label className="flex items-center gap-2 text-sm select-none">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => {
                  setIncludeArchived(e.target.checked);
                  setPage(1);
                  // reflect to URL
                  const params = new URLSearchParams(searchParams.toString());
                  if (e.target.checked) params.set("includeArchived", "1");
                  else params.delete("includeArchived");
                  router.replace(`${pathname}?${params.toString()}`.replace(/\?$/, ""), { scroll: false });
                }}
              />
              Include archived
            </label>
            <div className="flex items-center gap-2 text-sm">
              <span>Rows:</span>
              <select
                className="border rounded-md h-9 bg-background px-2"
                value={pageSize}
                onChange={(e) => { setPageSize(parseInt(e.target.value, 10)); setPage(1); }}
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </div>
          </div>

          {/* Products Table (desktop) */}
          <div className="hidden md:block">
            <div className="overflow-x-auto border-0 shadow-sm">
              <Table className="admin-products-table">
            <TableHeader>
              <TableRow>
                <TableHead className="w-1/3">Name</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Stock</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right w-[200px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    {(() => {
                      const q = (search || "").trim();
                      const name: string = p.name || "";
                      const isPrefix = q.length > 0 && name.toLowerCase().startsWith(q.toLowerCase());
                      const prefix = isPrefix ? name.slice(0, q.length) : "";
                      const rest = isPrefix ? name.slice(q.length) : name;
                      return (
                        <span className={p.archived ? "opacity-60 line-through" : undefined}>
                          {isPrefix ? (
                            <>
                              <span className="font-semibold underline decoration-primary/50">{prefix}</span>
                              <span>{rest}</span>
                            </>
                          ) : (
                            <span>{name}</span>
                          )}
                          {p.archived && (
                            <span className="ml-2 text-xs bg-muted border rounded px-1.5 py-0.5">Archived</span>
                          )}
                        </span>
                      );
                    })()}
                  </TableCell>
                  <TableCell>{formatCurrency(Number(p.price))}</TableCell>
                  <TableCell>{p.stock}</TableCell>
                  <TableCell>{new Date(p.updatedAt).toLocaleDateString()}</TableCell>
                  <TableCell className="text-right w-[200px] overflow-visible">
                    <div className="flex w-full items-center justify-end">
                      <DropdownMenu>
                        <Tooltip content="Edit or delete this product">
                          <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm">
                              Actions <MoreVertical className="ml-1 h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                        </Tooltip>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditId(p.id)}>Edit</DropdownMenuItem>
                          {p.archived ? (
                            <DropdownMenuItem
                              onClick={async () => {
                                const editReason = getArchiveReason("unarchive");
                                if (!editReason) return;
                                const res = await fetch(`/api/products/${p.id}`, {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ archived: false, editReason }),
                                });
                                if (!res.ok) {
                                  const j = await res
                                    .json()
                                    .catch(async () => ({ error: await res.text().catch(() => "") }));
                                  toast.error(j?.error || "Failed to unarchive");
                                } else {
                                  toast.success("Product unarchived");
                                  queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
                                }
                              }}
                            >
                              Unarchive
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              disabled={Number(p.stock || 0) > 0}
                              onClick={async () => {
                                if (Number(p.stock || 0) > 0) {
                                  toast.error("Cannot archive a product with stock greater than 0.");
                                  return;
                                }
                                const editReason = getArchiveReason("archive");
                                if (!editReason) return;
                                const res = await fetch(`/api/products/${p.id}`, {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ archived: true, editReason }),
                                });
                                if (!res.ok) {
                                  const j = await res
                                    .json()
                                    .catch(async () => ({ error: await res.text().catch(() => "") }));
                                  toast.error(j?.error || "Failed to archive");
                                } else {
                                  toast.success("Product archived");
                                  queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
                                }
                              }}
                            >
                              {Number(p.stock || 0) > 0 ? "Archive (stock must be 0)" : "Archive"}
                            </DropdownMenuItem>
                          )}
                          {(p.orderCount ?? 0) === 0 && (
                            <DropdownMenuItem variant="destructive" onClick={() => setDeleteId(p.id)}>
                              Delete
                            </DropdownMenuItem>
                          )}
                          {(p.orderCount ?? 0) > 0 && (
                            <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                              Delete hidden (order history)
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {products.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-6 text-muted-foreground">
                    No products found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Products list (mobile) */}
      <div className="md:hidden space-y-3">
            {products.map((p) => (
          <div key={p.id} className="rounded-lg border p-4 space-y-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-semibold">
                {(() => {
                  const q = (search || "").trim();
                  const name: string = p.name || "";
                  const isPrefix = q.length > 0 && name.toLowerCase().startsWith(q.toLowerCase());
                  const prefix = isPrefix ? name.slice(0, q.length) : "";
                  const rest = isPrefix ? name.slice(q.length) : name;
                  return (
                    <span className={p.archived ? "opacity-60 line-through" : undefined}>
                      {isPrefix ? (
                        <>
                          <span className="font-semibold underline decoration-primary/50">{prefix}</span>
                          <span>{rest}</span>
                        </>
                      ) : (
                        <span>{name}</span>
                      )}
                      {p.archived && (
                        <span className="ml-2 text-xs bg-muted border rounded px-1.5 py-0.5">Archived</span>
                      )}
                    </span>
                  );
                })()}
              </div>
              <div className="text-xs text-muted-foreground">{new Date(p.updatedAt).toLocaleDateString()}</div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <p className="uppercase tracking-wide text-muted-foreground">Price</p>
                <p className="font-semibold">{formatCurrency(Number(p.price))}</p>
              </div>
              <div>
                <p className="uppercase tracking-wide text-muted-foreground">Stock</p>
                <p className="font-semibold">{p.stock}</p>
              </div>
            </div>
            <div className="grid gap-2 pt-1 sm:grid-cols-2">
              <Button size="sm" variant="secondary" className="w-full" onClick={() => setEditId(p.id)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                disabled={!p.archived && Number(p.stock || 0) > 0}
                onClick={async () => {
                  if (!p.archived && Number(p.stock || 0) > 0) {
                    toast.error("Cannot archive a product with stock greater than 0.");
                    return;
                  }
                  const editReason = getArchiveReason(p.archived ? "unarchive" : "archive");
                  if (!editReason) return;
                  const res = await fetch(`/api/products/${p.id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ archived: !p.archived, editReason }),
                  });
                  if (!res.ok) {
                    const j = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
                    toast.error(j?.error || (p.archived ? "Failed to unarchive" : "Failed to archive"));
                  } else {
                    toast.success(p.archived ? "Product unarchived" : "Product archived");
                    queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
                  }
                }}
              >
                {p.archived
                  ? "Unarchive"
                  : Number(p.stock || 0) > 0
                  ? "Archive (stock must be 0)"
                  : "Archive"}
              </Button>
              {(p.orderCount ?? 0) === 0 && (
                <Button
                  size="sm"
                  variant="destructive"
                  className="w-full sm:col-span-2"
                  onClick={() => setDeleteId(p.id)}
                >
                  Delete
                </Button>
              )}
              {(p.orderCount ?? 0) > 0 && (
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  Delete hidden because this product has order history.
                </p>
              )}
            </div>
          </div>
        ))}
        {products.length === 0 && (
          <p className="text-center text-sm text-muted-foreground">No products found.</p>
        )}
      </div>

      {/* Pagination */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 pt-4 border-t text-sm">
        <span className="text-sm text-muted-foreground">
          Page {page} of {totalPages} ({total} total)
        </span>
        {totalPages > 1 && (
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious href="#" onClick={(e) => { e.preventDefault(); if (page > 1) setPage(page - 1); }} />
              </PaginationItem>
              {(() => {
                const pages: number[] = [];
                const start = Math.max(1, page - 2);
                const end = Math.min(totalPages, page + 2);
                for (let i = start; i <= end; i++) pages.push(i);
                return (
                  <>
                    {start > 1 && (
                      <PaginationItem>
                        <PaginationLink href="#" onClick={(e) => { e.preventDefault(); setPage(1); }}>1</PaginationLink>
                      </PaginationItem>
                    )}
                    {start > 2 && (
                      <PaginationItem>
                        <span className="px-2">…</span>
                      </PaginationItem>
                    )}
                    {pages.map((n) => (
                      <PaginationItem key={n}>
                        <PaginationLink href="#" isActive={n === page} onClick={(e) => { e.preventDefault(); setPage(n); }}>
                          {n}
                        </PaginationLink>
                      </PaginationItem>
                    ))}
                    {end < totalPages - 1 && (
                      <PaginationItem>
                        <span className="px-2">…</span>
                      </PaginationItem>
                    )}
                    {end < totalPages && (
                      <PaginationItem>
                        <PaginationLink href="#" onClick={(e) => { e.preventDefault(); setPage(totalPages); }}>
                          {totalPages}
                        </PaginationLink>
                      </PaginationItem>
                    )}
                  </>
                );
              })()}
              <PaginationItem>
                <PaginationNext href="#" onClick={(e) => { e.preventDefault(); if (page < totalPages) setPage(page + 1); }} />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        )}
      </div>
      {editId && (
        <EditProductDialog
          product={products.find((x) => x.id === editId)!}
          open={true}
          onOpenChange={(o) => {
            if (!o) setEditId(null);
          }}
        />
      )}
      {deleteId && (
        <DeleteProductDialog
          id={deleteId}
          name={products.find((x) => x.id === deleteId)?.name || "Product"}
          open={true}
          onOpenChange={(o) => { if (!o) setDeleteId(null); }}
        />
      )}
      </>
      )}
    </section>
  );
}

export default function AdminProductsPage() {
  return (
    <Suspense
      fallback={
        <section className="p-6">
          <h1 className="text-2xl font-semibold mb-2">Admin - Products</h1>
          <p className="text-sm text-muted-foreground">Loading products…</p>
        </section>
      }
    >
      <AdminProductsContent />
    </Suspense>
  );
}

// Helper: detect if the event target is a text input element
function isTextInput(el: EventTarget | null): boolean {
  if (!el || !(el as HTMLElement).tagName) return false;
  const tag = String((el as HTMLElement).tagName).toLowerCase();
  if (tag === "input") {
    const type = String(((el as HTMLInputElement).type || "").toLowerCase());
    return ["text", "search", "email", "number", "url", "tel", "password"].includes(type);
  }
  if (tag === "textarea") return true;
  // contenteditable
  try { return !!(el as HTMLElement).isContentEditable; } catch { return false; }
}

// Add Product Dialog
function AddProductDialog() {
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  const form = useForm<z.input<typeof productSchema>>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      name: "",
      description: "",
      imageUrl: "",
      price: 0,
      cost: 0,
      stock: 0,
    },
  });

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (data.url) {
      form.setValue("imageUrl", data.url);
      setPreview(data.url);
      toast.success("Image uploaded");
    } else {
      toast.error("Failed to upload image");
    }
    setUploading(false);
  };

  const onSubmit = async (values: z.input<typeof productSchema>) => {
    try {
      const capitalizedName = toTitleCase(values.name || "");
      const payload = {
        ...values,
        name: capitalizedName,
        price: Number(values.price),
        cost: Number(values.cost),
        stock: Number(values.stock),
      };
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err?.error || "Failed to add product");
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["admin","products"] });
      toast.success(`${values.name} added successfully`);
      form.reset();
      setPreview(null);
      setOpen(false);
    } catch (e) {
      console.error(e);
      toast.error("Unexpected error adding product");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default">+ Add Product</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add New Product</DialogTitle>
        </DialogHeader>
        <form
            onSubmit={form.handleSubmit(
              onSubmit,
              (errs) => {
                const first = Object.values(errs)[0];
                const message =
                  typeof first?.message === "string"
                    ? first.message
                    : "Please fix the highlighted fields";
                toast.error(message);
              },
            )}
          className="space-y-2"
        >
          <Label>Name</Label>
          <Input
            {...form.register("name")}
            className={`capitalize ${form.formState.errors.name ? "border-red-500" : ""}`}
          />
          {form.formState.errors.name && (
            <p className="text-xs text-red-600">{String(form.formState.errors.name.message)}</p>
          )}
          {form.formState.errors.name && (
            <p className="text-xs text-red-600">{String(form.formState.errors.name.message)}</p>
          )}

          <Label>Description</Label>
          <Input
            {...form.register("description")}
            className={form.formState.errors.description ? "border-red-500" : undefined}
          />
           {form.formState.errors.description && (
            <p className="text-xs text-red-600">{String(form.formState.errors.description.message)}</p>
          )}
          {form.formState.errors.description && (
            <p className="text-xs text-red-600">{String(form.formState.errors.description.message)}</p>
          )}

          <Label>Image</Label>
          <div className="grid gap-2">
            <Input
              placeholder="https://example.com/image.jpg or /images/file.jpg"
              {...form.register("imageUrl")}
              className={form.formState.errors.imageUrl ? "border-red-500" : undefined}
            />
            <p className="text-xs text-muted-foreground">Or upload a file:</p>
            <Input
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className={form.formState.errors.imageUrl ? "border-red-500" : undefined}
            />
          </div>
          {uploading && <p className="text-sm text-muted-foreground">Uploading...</p>}
          {(() => {
            const url = (form.watch("imageUrl") as string) || preview || "";
            return url ? (
              <div className="flex items-center gap-3">
                <img src={url} alt="Preview" className="w-32 h-32 object-cover rounded-md border" />
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm underline text-primary"
                  title="Open image in new tab"
                >
                  Open image
                </a>
              </div>
            ) : null;
          })()}
          {form.formState.errors.imageUrl && (
            <p className="text-xs text-red-600">{String(form.formState.errors.imageUrl.message)}</p>
          )}

          <Label>Price</Label>
          <Input
            type="number"
            step="0.01"
            {...form.register("price", { valueAsNumber: true })}
            className={form.formState.errors.price ? "border-red-500" : undefined}
          />
          {form.formState.errors.price && (
            <p className="text-xs text-red-600">{String(form.formState.errors.price.message)}</p>
          )}
          {form.formState.errors.price && (
            <p className="text-xs text-red-600">{String(form.formState.errors.price.message)}</p>
          )}

          <div>
            <Label>Cost (initial)</Label>
            <Input
              type="number"
              step="0.01"
              {...form.register("cost", { valueAsNumber: true })}
              className={form.formState.errors.cost ? "border-red-500" : undefined}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Used as the starting average cost. Subsequent purchases will update the weighted cost automatically.
            </p>
            {form.formState.errors.cost && (
              <p className="text-xs text-red-600">{String(form.formState.errors.cost.message)}</p>
            )}
          </div>

          <Label>Stock</Label>
          <Input
            type="number"
            {...form.register("stock", { valueAsNumber: true })}
            className={form.formState.errors.stock ? "border-red-500" : undefined}
          />
          {form.formState.errors.stock && (
            <p className="text-xs text-red-600">{String(form.formState.errors.stock.message)}</p>
          )}
          {form.formState.errors.stock && (
            <p className="text-xs text-red-600">{String(form.formState.errors.stock.message)}</p>
          )}

          <div className="flex justify-end pt-3">
            <Button type="submit" disabled={uploading}>Save</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Edit Dialog
type AdminProduct = {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  price: number | string;
  cost: number | string;
  stock: number;
  archived?: boolean;
  orderCount?: number;
  updatedAt: string | Date;
};

function EditProductDialog({
  product,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  product: AdminProduct;
  trigger?: React.ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const actualOpen = controlledOpen !== undefined ? controlledOpen : open;
  const setActualOpen = onOpenChange || setOpen;
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(product.imageUrl);
  const [saving, setSaving] = useState(false);

  const form = useForm<z.input<typeof productEditSchema>>({
    resolver: zodResolver(productEditSchema),
    defaultValues: {
      name: product.name,
      description: product.description ?? undefined,
      imageUrl: product.imageUrl ?? undefined,
      price: product.price,
      stock: product.stock,
      editReason: "",
    },
  });

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (data.url) {
      form.setValue("imageUrl", data.url);
      setPreview(data.url);
      toast.success("Image uploaded");
    } else {
      toast.error("Failed to upload image");
    }
    setUploading(false);
  };

  const onSubmit = async (values: z.input<typeof productEditSchema>) => {
    try {
      setSaving(true);
      const payload: Partial<Pick<AdminProduct, "name" | "description" | "imageUrl" | "price" | "stock">> & {
        editReason?: string;
      } = {};
      if (typeof values.name === "string" && values.name.trim() !== "") {
        const capitalized = toTitleCase(values.name.trim());
        payload.name = capitalized;
      }
      if (typeof values.description === "string" && values.description.trim() !== "") {
        payload.description = values.description.trim();
      }
      if (typeof values.imageUrl === "string" && values.imageUrl.trim() !== "") {
        payload.imageUrl = values.imageUrl.trim();
      }
      if (values.price !== undefined && values.price !== null && !Number.isNaN(Number(values.price))) {
        payload.price = Number(values.price);
      }
      if (values.stock !== undefined && values.stock !== null && !Number.isNaN(Number(values.stock))) {
        payload.stock = Number(values.stock);
      }
      if (typeof values.editReason === "string" && values.editReason.trim() !== "") {
        payload.editReason = values.editReason.trim();
      }
      // If nothing to update, bail early
      const { editReason, ...changes } = payload;
      if (Object.keys(changes).length === 0) {
        toast.info("No changes to save");
        setSaving(false);
        return;
      }
      if (!editReason) {
        toast.error("Please add a brief reason for this change.");
        setSaving(false);
        return;
      }
      const res = await fetch(`/api/products/${product.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err?.error || "Failed to update product");
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["admin","products"] });
      toast.success(`${payload.name} updated`);
      form.setValue("editReason", "");
      setActualOpen(false);
    } catch (e) {
      console.error(e);
      toast.error("Unexpected error updating product");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={actualOpen} onOpenChange={setActualOpen}>
      <DialogTrigger asChild>
        {trigger || <Button size="sm" variant="secondary">Edit</Button>}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-h-[85vh] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Product</DialogTitle>
        </DialogHeader>
        <form
            onSubmit={form.handleSubmit(
              onSubmit,
              (errs) => {
                const first = Object.values(errs)[0];
                const message =
                  typeof first?.message === "string"
                    ? first.message
                    : "Please fix the highlighted fields";
                toast.error(message);
              },
            )}
          className="space-y-2"
        >
          <fieldset disabled={uploading || saving} className="space-y-2">
            <Label>Name</Label>
            <Input
              {...form.register("name")}
              className={`capitalize ${form.formState.errors.name ? "border-red-500" : ""}`}
            />

            <Label>Description</Label>
            <Input
              {...form.register("description")}
              className={form.formState.errors.description ? "border-red-500" : undefined}
            />

          <Label>Image</Label>
          <div className="grid gap-2">
            <Input
              placeholder="https://example.com/image.jpg or /images/file.jpg"
              {...form.register("imageUrl")}
              className={form.formState.errors.imageUrl ? "border-red-500" : undefined}
            />
            <p className="text-xs text-muted-foreground">Or upload a file:</p>
            <Input
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className={form.formState.errors.imageUrl ? "border-red-500" : undefined}
            />
          </div>
          {uploading && <p className="text-sm text-muted-foreground">Uploading...</p>}
          {(() => {
            const url = (form.watch("imageUrl") as string) || preview || "";
            return url ? (
              <div className="flex items-center gap-3">
                <img src={url} alt="Preview" className="w-32 h-32 object-cover rounded-md border" />
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm underline text-primary"
                  title="Open image in new tab"
                >
                  Open image
                </a>
              </div>
            ) : null;
          })()}

            <Label>Price</Label>
            <Input
              type="number"
              step="0.01"
              {...form.register("price", { valueAsNumber: true })}
              className={form.formState.errors.price ? "border-red-500" : undefined}
            />
            {form.formState.errors.price && (
              <p className="text-xs text-red-600">{String(form.formState.errors.price.message)}</p>
            )}

            <Label>Cost (auto-calculated)</Label>
            <Input
              type="number"
              step="0.01"
              value={Number(product.cost || 0)}
              readOnly
              disabled
              className="bg-muted"
            />
            <p className="text-xs text-muted-foreground">
              Cost is the weighted average from purchases and cannot be edited here.
            </p>

            <Label>Stock</Label>
            <Input
              type="number"
              {...form.register("stock", { valueAsNumber: true })}
              className={form.formState.errors.stock ? "border-red-500" : undefined}
            />
            {form.formState.errors.stock && (
              <p className="text-xs text-red-600">{String(form.formState.errors.stock.message)}</p>
            )}

            <Label>Reason for change</Label>
            <Input
              placeholder="e.g., correcting description / stock audit / price update"
              {...form.register("editReason")}
              className={form.formState.errors.editReason ? "border-red-500" : undefined}
            />
            {form.formState.errors.editReason && (
              <p className="text-xs text-red-600">
                {String(form.formState.errors.editReason.message)}
              </p>
            )}

            <div className="flex justify-end pt-3">
              <Button type="submit" disabled={uploading || saving}>
                {saving ? (
                  <>
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save"
                )}
              </Button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Delete Dialog
function DeleteProductDialog({ id, name, trigger, open: controlledOpen, onOpenChange }: { id: string; name: string; trigger?: React.ReactElement; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const actualOpen = controlledOpen !== undefined ? controlledOpen : open;
  const setActualOpen = onOpenChange || setOpen;

  const handleDelete = async () => {
    try {
      setDeleting(true);
      const res = await fetch(`/api/products/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
        toast.error(j?.error || "Failed to delete product");
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["admin","products"] });
      toast.warning(`${name} deleted`);
      setActualOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={actualOpen} onOpenChange={setActualOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button size="sm" variant="destructive" className="text-white">Delete</Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
        <DialogHeader>
          <DialogTitle>Delete {name}?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground mb-4">This action cannot be undone.</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setActualOpen(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? (
              <>
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                Deleting...
              </>
            ) : (
              "Confirm"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
