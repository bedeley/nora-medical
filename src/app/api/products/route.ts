import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

/**
 * ✅ Zod schema for new product creation
 */
// Accept absolute URLs (https://...) or a site-relative path that starts with '/'
const urlOrPath = z
  .string()
  .refine(
    (val) => {
      try {
        new URL(val);
        return true;
      } catch {
        return typeof val === "string" && val.startsWith("/");
      }
    },
    {
      message:
        "Provide a full URL like https://example.com/image.jpg or a site path starting with /images/...",
    }
  );

export const productSchema = z.object({
  name: z.string().min(2, { message: "Name is required" }),
  description: z.string().min(5, { message: "Description is too short" }),
  imageUrl: urlOrPath,
  price: z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .refine((v) => !isNaN(v), { message: "Price must be a number" })
    .refine((v) => v >= 0, { message: "Price cannot be negative" }),
  // Initial cost at creation, used as starting average cost (required and must be > 0)
  cost: z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .refine((v) => !isNaN(v), { message: "Cost must be a number" })
    .refine((v) => v > 0, { message: "Cost must be greater than 0" }),
  stock: z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v), { message: "Stock must be an integer" })
    .refine((v) => v >= 0, { message: "Stock cannot be negative" }),
});

/**
 * ✅ GET /api/products
 * Supports ?q=searchTerm, ?page, ?pageSize
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") || "";
  const page = Number(searchParams.get("page") || 1);
  const pageSize = Number(searchParams.get("pageSize") || 12);
  const sort = (searchParams.get("sort") || "createdAt") as
    | "createdAt"
    | "updatedAt";

  try {
    const includeArchived = searchParams.get("includeArchived") === "1";
    const startsWith = searchParams.get("startsWith") === "1";
    const nameFilter =
      q && startsWith
        ? { name: { startsWith: q, mode: "insensitive" as const } }
        : q
        ? { name: { contains: q, mode: "insensitive" as const } }
        : null;

    const where = {
      AND: [
        nameFilter
          ? {
              OR: [
                nameFilter,
                ...(startsWith
                  ? []
                  : [{ description: { contains: q, mode: "insensitive" as const } }]),
              ],
            }
          : {},
        includeArchived ? {} : { archived: false },
      ],
    } satisfies NonNullable<Parameters<typeof prisma.product.findMany>[0]>["where"];

    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        // Allow sorting by updatedAt (for admin) or createdAt (default)
        orderBy: { [sort]: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.product.count({ where }),
    ]);

    // ✅ Normalize Prisma Decimal/Date
    const safeItems = items.map((p: typeof items[number]) => ({
      ...p,
      price: Number(p.price),
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    }));

    return NextResponse.json({
      items: safeItems,
      total,
      page,
      pageSize,
    });
  } catch (error) {
    console.error("Error fetching products:", error);
    return NextResponse.json(
      { error: "Failed to fetch products" },
      { status: 500 }
    );
  }
}

/**
 * ✅ POST /api/products
 * Create a new product (admin only)
 */
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);

  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = productSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid data", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const product = await prisma.product.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description,
        imageUrl: parsed.data.imageUrl,
        price: parsed.data.price,
        cost: parsed.data.cost,
        stock: parsed.data.stock,
      },
    });

    // If an initial stock and cost are provided, record a baseline purchase and inventory movement
    try {
      const initialQty = Number(parsed.data.stock || 0);
      const unitCost = Number(parsed.data.cost || 0);
      if (initialQty > 0 && unitCost >= 0) {
        const purchase = await prisma.purchase.create({
          data: {
            productId: product.id,
            quantity: initialQty,
            unitCost: unitCost,
            supplier: "Initial Stock",
            note: "Auto-created with product",
          },
        });
        await prisma.inventoryMovement.create({
          data: {
            productId: product.id,
            delta: initialQty,
            reason: "PURCHASE",
            purchaseId: purchase.id,
          },
        });
      }
    } catch (e) {
      // Non-blocking; product already created
      console.warn("Failed to create initial purchase for product", product.id, e);
    }

    const safeProduct = {
      ...product,
      price: Number(product.price),
      createdAt: product.createdAt.toISOString(),
      updatedAt: product.updatedAt.toISOString(),
    };

    return NextResponse.json(safeProduct);
  } catch (error) {
    console.error("Error creating product:", error);
    return NextResponse.json(
      { error: "Failed to create product" },
      { status: 500 }
    );
  }
}

