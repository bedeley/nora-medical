import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { notifyOrderEvent, notifyPaymentEvent } from "@/lib/notifications";
import { computeReceiptHash } from "@/lib/receipt-hash";
import { rateLimit } from "@/lib/rate-limit";
import { allocateLotsForSale } from "@/lib/inventory-lots";
import { postOrderEntry, postPaymentEntry } from "@/lib/accounting-posting";
import { isCreditLimitExceeded } from "@/lib/credit";
import { getOtcShiftDayStatus } from "@/lib/otc-shift-close";
import bcrypt from "bcryptjs";
import { roundCurrency } from "@/lib/currency";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

const createSchema = z
  .object({
    customerType: z.enum(["REGISTERED", "WALK_IN"]).default("REGISTERED"),
    userId: z.string().optional(),
    linkedCustomerId: z.string().optional(),
    sourceTenderId: z.string().optional(),
    walkInName: z.string().max(80).optional(),
    walkInPhone: z.string().max(30).optional(),
    allowAnonymousWalkIn: z.boolean().optional(),
    anonymousReason: z.string().max(200).optional(),
    items: z
      .array(
        z.object({
          productId: z.string().min(1),
          quantity: z.number().int().positive(),
          deliveredQuantity: z.number().int().min(0).optional(),
        })
      )
      .min(1, "At least one item required"),
    initialPayment: z.number().min(0).optional(),
    initialPaymentMethod: z
      .enum(["cash", "transfer", "momo"])
      .optional(),
    initialPaymentReference: z.string().max(120).optional(),
    shiftSession: z.string().max(80).optional(),
    forceClosedShiftOverride: z.boolean().optional(),
    closedShiftOverrideReason: z.string().max(300).optional(),
    discountAmount: z.number().min(0).optional(),
    discountReason: z.string().max(200).optional(),
    note: z.string().max(2000).optional(),
    taxRate: z.number().min(0).max(100).optional(),
    deliveryStatus: z
      .enum(["NOT_DELIVERED", "PARTIALLY_DELIVERED", "DELIVERED", "RETURNED"])
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.customerType === "REGISTERED" && !data.userId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Customer is required for registered orders.",
        path: ["userId"],
      });
    }
    if (data.customerType === "WALK_IN") {
      const hasName = Boolean(data.walkInName?.trim());
      const isAnonymousAllowed = Boolean(data.allowAnonymousWalkIn);
      const hasAnonymousReason = Boolean(data.anonymousReason?.trim());
      if (!hasName && !isAnonymousAllowed) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Walk-in name is required unless anonymous walk-in override is enabled.",
          path: ["walkInName"],
        });
      }
      if (!hasName && isAnonymousAllowed && !hasAnonymousReason) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Anonymous walk-in reason is required when walk-in name is omitted.",
          path: ["anonymousReason"],
        });
      }
    }
    const initialPaymentAmount = Number(data.initialPayment || 0);
    const requiresProviderReference =
      data.initialPaymentMethod === "momo" || data.initialPaymentMethod === "transfer";

    if (data.initialPaymentMethod && !(Number.isFinite(initialPaymentAmount) && initialPaymentAmount > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Initial payment amount is required when payment method is selected.",
        path: ["initialPayment"],
      });
    }
    if (
      requiresProviderReference &&
      Number.isFinite(initialPaymentAmount) &&
      initialPaymentAmount > 0 &&
      !data.initialPaymentReference?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Payment reference is required for MoMo and transfer payments.",
        path: ["initialPaymentReference"],
      });
    }
    if (initialPaymentAmount > 0 && !data.initialPaymentMethod) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Payment method is required when initial payment is entered.",
        path: ["initialPaymentMethod"],
      });
    }
    if (data.forceClosedShiftOverride && !data.closedShiftOverrideReason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Override reason is required when bypassing closed shift lock.",
        path: ["closedShiftOverrideReason"],
      });
    }
    if (data.deliveryStatus === "PARTIALLY_DELIVERED") {
      let deliveredAny = false;
      let hasRemaining = false;
      for (let index = 0; index < data.items.length; index += 1) {
        const item = data.items[index];
        if (item.deliveredQuantity === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Delivered quantity is required for partial delivery.",
            path: ["items", index, "deliveredQuantity"],
          });
          continue;
        }
        if (item.deliveredQuantity > item.quantity) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Delivered quantity cannot exceed ordered quantity.",
            path: ["items", index, "deliveredQuantity"],
          });
          continue;
        }
        if (item.deliveredQuantity > 0) deliveredAny = true;
        if (item.deliveredQuantity < item.quantity) hasRemaining = true;
      }
      if (!deliveredAny) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "At least one line must have delivered quantity greater than zero.",
          path: ["deliveryStatus"],
        });
      } else if (!hasRemaining) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "All lines are fully delivered. Use delivery status DELIVERED.",
          path: ["deliveryStatus"],
        });
      }
    }
    if (
      data.forceClosedShiftOverride &&
      data.closedShiftOverrideReason &&
      data.closedShiftOverrideReason.trim().length < 10
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Override reason must be at least 10 characters.",
        path: ["closedShiftOverrideReason"],
      });
    }
    if (Number(data.discountAmount || 0) > 0 && !data.discountReason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Discount reason is required when discount amount is entered.",
        path: ["discountReason"],
      });
    }
  });

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-order-create", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = await req.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid payload", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const {
      customerType,
      userId,
      linkedCustomerId,
      sourceTenderId,
      walkInName,
      walkInPhone,
      allowAnonymousWalkIn,
      anonymousReason,
      items,
      initialPayment = 0,
      initialPaymentMethod,
      initialPaymentReference,
      shiftSession,
      forceClosedShiftOverride = false,
      closedShiftOverrideReason,
      discountAmount = 0,
      discountReason,
      note,
      deliveryStatus,
      taxRate = 0,
    } = parsed.data;

    const isWalkIn = customerType === "WALK_IN";
    const effectiveDeliveryStatus = isWalkIn
      ? (deliveryStatus ?? "DELIVERED")
      : deliveryStatus;
    let resolvedUserId = isWalkIn ? (linkedCustomerId || null) : (userId || null);
    let resolvedCustomerName: string | null = null;
    let resolvedCustomerEmail: string | null = null;
    let resolvedCustomerPhone: string | null = null;
    let resolvedWalkInName = isWalkIn
      ? (walkInName?.trim() || (allowAnonymousWalkIn ? "Walk-in Anonymous" : "Walk-in Customer"))
      : null;
    const resolvedWalkInPhone = isWalkIn ? (walkInPhone?.trim() || null) : null;
    const anonymousTag =
      isWalkIn && !walkInName?.trim() && allowAnonymousWalkIn && anonymousReason?.trim()
        ? `ANONYMOUS_OTC: ${anonymousReason.trim()}`
        : null;
    const shiftTag = shiftSession?.trim() ? `OTC_SHIFT_SESSION: ${shiftSession.trim()}` : null;
    const effectiveAdminNote = [note?.trim() || "", shiftTag || "", anonymousTag || ""].filter(Boolean).join(" | ") || null;
    const normalizedClosedShiftOverrideReason = String(closedShiftOverrideReason || "").trim();

    if (isWalkIn) {
      const shiftStatus = await getOtcShiftDayStatus();
      if (!shiftStatus.isOpen && !shiftStatus.isClosed) {
        return NextResponse.json(
          {
            error:
              "OTC shift is not opened for today. Open shift first before creating OTC sales.",
            code: "OTC_SHIFT_NOT_OPEN",
            day: shiftStatus.day,
          },
          { status: 409 },
        );
      }
      if (shiftStatus.isClosed) {
        if (!isAdmin || !forceClosedShiftOverride || normalizedClosedShiftOverrideReason.length < 10) {
          return NextResponse.json(
            {
              error:
                "OTC shift is already closed for today. Open the next shift/session or request admin override.",
              code: "OTC_SHIFT_CLOSED",
              day: shiftStatus.day,
              shiftCloseId: shiftStatus.closeEventId,
              closedAt: shiftStatus.closedAt,
            },
            { status: 409 },
          );
        }
      }
    }
    if (!isAdmin && Number(discountAmount || 0) > 0) {
      return NextResponse.json({ error: "Only admins can apply OTC discount." }, { status: 403 });
    }

    // For named OTC orders, auto-link to existing customer by phone when possible,
    // or create a lightweight CUSTOMER profile so account history/credit remains traceable.
    if (
      isWalkIn &&
      !resolvedUserId &&
      resolvedWalkInName &&
      resolvedWalkInName !== "Walk-in Anonymous"
    ) {
      const normalizedPhone = resolvedWalkInPhone ? String(resolvedWalkInPhone).trim() : null;
      if (normalizedPhone) {
        const existingByPhone = await prisma.user.findFirst({
          where: { phone: normalizedPhone, deletedAt: null },
          select: { id: true },
        });
        if (existingByPhone?.id) {
          resolvedUserId = existingByPhone.id;
        }
      }
      if (!resolvedUserId) {
        const placeholderPassword = await bcrypt.hash(
          `otc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          10,
        );
        const createdCustomer = await prisma.user.create({
          data: {
            name: resolvedWalkInName,
            phone: normalizedPhone || null,
            password: placeholderPassword,
            role: "CUSTOMER",
          },
          select: { id: true },
        });
        resolvedUserId = createdCustomer.id;
        resolvedCustomerName = resolvedWalkInName || null;
        resolvedCustomerPhone = normalizedPhone || null;
      }
    }

    // Validate user exists for registered orders / linked walk-in profiles
    if (resolvedUserId) {
      const linkedUser = await prisma.user.findUnique({ where: { id: resolvedUserId } });
      if (!linkedUser) {
        return NextResponse.json({ error: "User not found" }, { status: 404 });
      }
      if (
        linkedUser.role !== "CUSTOMER" &&
        linkedUser.role !== "ADMIN" &&
        linkedUser.role !== "STAFF" &&
        linkedUser.role !== "ACCOUNTANT"
      ) {
        return NextResponse.json({ error: "Invalid linked customer" }, { status: 400 });
      }
      resolvedCustomerName = linkedUser.name || null;
      resolvedCustomerEmail = linkedUser.email || null;
      resolvedCustomerPhone = linkedUser.phone || null;
      if (isWalkIn && linkedCustomerId && resolvedCustomerName) {
        // Persist canonical customer name for linked OTC orders (avoid partial typed aliases).
        resolvedWalkInName = resolvedCustomerName;
      }
    }

    // Fetch products and validate quantities/availability
    const productIds = [...new Set(items.map((i) => i.productId))];
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
    });
    type ProductLookup = {
      id: string;
      price: unknown;
      cost: unknown;
      stock: number;
      name: string;
      archived: boolean;
      requiresLotTracking?: boolean | null;
      requiresExpiryDate?: boolean | null;
    };
    const productMap = new Map<string, ProductLookup>(
      products.map((p: ProductLookup) => [p.id, p as unknown as ProductLookup])
    );
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const lotTrackedIds = products
      .filter((p) => Boolean((p as ProductLookup).requiresLotTracking || (p as ProductLookup).requiresExpiryDate))
      .map((p) => p.id);
    const lotRows = lotTrackedIds.length
      ? await prisma.inventoryLot.findMany({
          where: {
            productId: { in: lotTrackedIds },
            quantityRemaining: { gt: 0 },
            OR: [{ expiryDate: null }, { expiryDate: { gte: today } }],
          },
          select: {
            productId: true,
            quantityRemaining: true,
          },
        })
      : [];
    const lotAvailableByProduct = new Map<string, number>();
    for (const row of lotRows) {
      lotAvailableByProduct.set(
        row.productId,
        Number(lotAvailableByProduct.get(row.productId) || 0) + Number(row.quantityRemaining || 0),
      );
    }

    for (const it of items) {
      const p = productMap.get(it.productId);
      if (!p) {
        return NextResponse.json({ error: `Product not found: ${it.productId}` }, { status: 400 });
      }
      if (p.archived) {
        return NextResponse.json({ error: `Product archived: ${p.name}` }, { status: 400 });
      }
      if (p.stock < it.quantity) {
        return NextResponse.json(
          { error: `Not enough stock for ${p.name}. Only ${p.stock} in stock.` },
          { status: 400 }
        );
      }
      if (p.requiresLotTracking || p.requiresExpiryDate) {
        const lotAvailable = Math.max(0, Math.floor(Number(lotAvailableByProduct.get(p.id) || 0)));
        const effectiveAvailable = Math.min(Math.max(0, Math.floor(Number(p.stock || 0))), lotAvailable);
        if (effectiveAvailable < it.quantity) {
          return NextResponse.json(
            {
              error: `Not enough sellable stock for ${p.name}. Only ${effectiveAvailable} available from unexpired lots.`,
            },
            { status: 400 },
          );
        }
      }
    }

    const subtotal = roundCurrency(
      items.reduce(
        (sum: number, it: { productId: string; quantity: number }) => {
          const p = productMap.get(it.productId)!;
          return sum + Number(p.price) * it.quantity;
        },
        0
      )
    );
    const normalizedTaxRate = Number.isFinite(taxRate) ? Math.max(0, taxRate) : 0;
    const taxAmount = roundCurrency(subtotal * (normalizedTaxRate / 100));
    const normalizedDiscount = Number.isFinite(discountAmount)
      ? Math.max(0, Math.min(Number(discountAmount), subtotal + taxAmount))
      : 0;
    const total = roundCurrency(Math.max(0, subtotal + taxAmount - normalizedDiscount));

    const amountPaid = roundCurrency(Math.min(initialPayment, total));
    const balance = roundCurrency(Math.max(0, total - amountPaid));
    if (isWalkIn && !walkInName?.trim() && allowAnonymousWalkIn && balance > 0) {
      return NextResponse.json(
        { error: "Anonymous OTC sale must be paid in full." },
        { status: 400 },
      );
    }
    let status = amountPaid <= 0 ? "UNPAID" : balance <= 0 ? "PAID" : "PARTIALLY_PAID";

    const order = await prisma.$transaction(async (tx: TxClient) => {
      let paymentId: string | null = null;
      const created = await tx.order.create({
        data: {
          userId: resolvedUserId,
          customerType,
          walkInName: resolvedWalkInName,
          walkInPhone: resolvedWalkInPhone,
          placedById: user?.id || null,
          adminNote: effectiveAdminNote,
          subtotal,
          taxRate: normalizedTaxRate,
          taxAmount,
          total,
          amountPaid,
          balance,
          status,
          ...(effectiveDeliveryStatus
            ? {
                deliveryStatus: effectiveDeliveryStatus,
                deliveredAt: effectiveDeliveryStatus === "DELIVERED" ? new Date() : null,
              }
            : {}),
        },
      });

      // Create items snapshot and decrement stock + inventory movement
      for (const it of items) {
        const p = productMap.get(it.productId)!;
        const oldStock = Number(p.stock ?? 0);
        const newStock = oldStock - it.quantity;
        await tx.orderItem.create({
          data: {
            orderId: created.id,
            productId: p.id,
            price: Number(p.price),
            costAtSale: Number(p.cost ?? 0),
            quantity: it.quantity,
            deliveredQuantity:
              effectiveDeliveryStatus === "DELIVERED"
                ? it.quantity
                : effectiveDeliveryStatus === "PARTIALLY_DELIVERED"
                  ? Number(it.deliveredQuantity ?? 0)
                  : 0,
          },
        });
        await tx.product.update({
          where: { id: p.id },
          data: {
            stock: { decrement: it.quantity },
            ...(oldStock > 0 && newStock <= 0 ? { lastStockoutAt: new Date() } : {}),
          },
        });
        p.stock = newStock;
        await allocateLotsForSale(tx, {
          productId: p.id,
          quantity: it.quantity,
          reason: "SALE",
        });
      }

      if (amountPaid > 0) {
        const meta = {
          method: initialPaymentMethod || "cash",
          reference:
            (initialPaymentMethod || "cash") === "cash"
              ? ("ADMIN_ORDER_INITIAL" as const)
              : (initialPaymentReference?.trim() || "ADMIN_ORDER_INITIAL"),
          location: "admin/orders/new",
          shiftSession: shiftSession?.trim() || undefined,
          note: effectiveAdminNote || "Admin initial payment",
          customerType,
          walkInName: resolvedWalkInName || undefined,
          walkInPhone: resolvedWalkInPhone || undefined,
          discountAmount: normalizedDiscount || undefined,
          discountReason: normalizedDiscount > 0 ? discountReason?.trim() || undefined : undefined,
        };
        const payment = await tx.payment.create({
          data: {
            userId: resolvedUserId,
            orderId: created.id,
            amount: amountPaid,
            note: JSON.stringify(meta),
          },
        });
        paymentId = payment.id;
      }

      const invoiceNumber = `INV-${created.id}`;
      const receiptHash = computeReceiptHash({
        orderId: created.id,
        invoiceNumber,
        subtotal,
        taxRate: normalizedTaxRate,
        taxAmount,
        total,
        createdAt: created.createdAt.toISOString(),
        items: items.map((it: { productId: string; quantity: number }) => {
          const p = productMap.get(it.productId)!;
          return {
            productId: p.id,
            quantity: it.quantity,
            price: Number(p.price),
          };
        }),
      });
      await tx.order.update({
        where: { id: created.id },
        data: { invoiceNumber, receiptHash },
      });

      // Apply credit limit hold for registered customers with outstanding balance
      if (resolvedUserId && balance > 0) {
        const { exceeded } = await isCreditLimitExceeded(tx, resolvedUserId);
        if (exceeded) {
          status = "ON_HOLD_CREDIT";
          await tx.order.update({
            where: { id: created.id },
            data: { status: "ON_HOLD_CREDIT" },
          });
        }
      }

      return { ...created, status, paymentId };
    });

    let orderPostingStatus: "POSTED" | "FAILED" | "SKIPPED" = "SKIPPED";
    let orderPostingError: string | null = null;
    let paymentPostingStatus: "POSTED" | "FAILED" | "SKIPPED" = "SKIPPED";
    let paymentPostingError: string | null = null;

    try {
      const postedOrder = await postOrderEntry({ orderId: order.id });
      orderPostingStatus = postedOrder?.id ? "POSTED" : "SKIPPED";
    } catch (e) {
      orderPostingStatus = "FAILED";
      orderPostingError = e instanceof Error ? e.message : "Failed to post order journal entry";
      console.warn("admin order auto-post error (order):", e);
    }

    if (order.paymentId) {
      try {
        const postedPayment = await postPaymentEntry({ paymentId: order.paymentId });
        paymentPostingStatus = postedPayment?.id ? "POSTED" : "SKIPPED";
      } catch (e) {
        paymentPostingStatus = "FAILED";
        paymentPostingError = e instanceof Error ? e.message : "Failed to post payment journal entry";
        console.warn("admin order auto-post error (payment):", e);
      }
    }

    // Customer-facing notifications
    try {
      if (resolvedUserId) {
        await notifyOrderEvent({
          kind: "order_created",
          userId: resolvedUserId,
          orderId: order.id,
          total,
          amountPaid,
        });
        if (amountPaid > 0) {
          await notifyPaymentEvent({
            kind: "payment_recorded",
            userId: resolvedUserId,
            amount: amountPaid,
            orderId: order.id,
            subject: "Payment received — updated receipt",
          });
        }
      }
    } catch (e) {
      console.warn("admin orders notifications error:", e);
    }

    // Audit log: admin-created order (and optional initial payment)
    try {
      await recordAuditLog({
        actorId: user?.id ?? null,
        action: "ORDER_CREATE_ADMIN",
        entityType: "ORDER",
        entityId: order.id,
        meta: {
          customerId: resolvedUserId,
          customerName: resolvedCustomerName || resolvedWalkInName || null,
          customerEmail: resolvedCustomerEmail,
          customerPhone: resolvedCustomerPhone || resolvedWalkInPhone || null,
          customerType,
          walkInName: resolvedWalkInName || undefined,
          adminNote: effectiveAdminNote || undefined,
          shiftSession: shiftSession?.trim() || undefined,
          createdFrom: isWalkIn ? "admin_orders_otc" : "admin_orders_new",
          deliveryStatus: effectiveDeliveryStatus || "NOT_DELIVERED",
          itemCount: items.length,
          totalQuantity: items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
          itemSummary: items
            .map((item) => {
              const product = productMap.get(item.productId);
              const label = product
                ? `${String(product.name || "").trim() || "Item"}`
                : "Item";
              return `${label} x${Number(item.quantity || 0)}`;
            })
            .join(", "),
          deliveredSummary: items
            .map((item) => {
              const product = productMap.get(item.productId);
              const name = String(product?.name || item.productId).trim() || item.productId;
              const ordered = Number(item.quantity || 0);
              const delivered =
                effectiveDeliveryStatus === "DELIVERED"
                  ? ordered
                  : effectiveDeliveryStatus === "PARTIALLY_DELIVERED"
                    ? Number(item.deliveredQuantity || 0)
                    : 0;
              return `${name} ${delivered}/${ordered}`;
            })
            .join(", "),
          initialPaymentMethod:
            amountPaid > 0 ? (initialPaymentMethod || "cash") : null,
          initialPaymentReference:
            amountPaid > 0
              ? (initialPaymentMethod || "cash") === "cash"
                ? null
                : initialPaymentReference?.trim() || null
              : null,
          discountAmount: normalizedDiscount,
          discountReason: normalizedDiscount > 0 ? discountReason?.trim() || null : null,
          subtotal,
          taxAmount,
          total,
          amountPaid,
          balance,
          status,
          orderPostingStatus,
          orderPostingError,
          paymentPostingStatus,
          paymentPostingError,
          sourceTenderId: sourceTenderId?.trim() || undefined,
          closedShiftOverride:
            isWalkIn && forceClosedShiftOverride && normalizedClosedShiftOverrideReason.length >= 10
              ? {
                  used: true,
                  reason: normalizedClosedShiftOverrideReason,
                }
              : undefined,
        },
      });
      if (sourceTenderId?.trim()) {
        await recordAuditLog({
          actorId: user?.id ?? null,
          action: "B2B_TENDER_ORDER_CREATED",
          entityType: "B2B_TENDER",
          entityId: sourceTenderId.trim(),
          meta: {
            orderId: order.id,
            orderStatus: status,
            amountPaid,
            total,
          },
        });
      }
    } catch {
      // best-effort
    }

    return NextResponse.json({
      success: true,
      orderId: order.id,
      total,
      amountPaid,
      balance,
      status,
      posting: {
        orderStatus: orderPostingStatus,
        orderError: orderPostingError,
        paymentStatus: paymentPostingStatus,
        paymentError: paymentPostingError,
        paymentExpected: Boolean(order.paymentId),
      },
    });
  } catch (err) {
    console.error("Admin create order error:", err);
    if (err instanceof Error) {
      if (err.message.includes("Not enough stock")) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      if (err.message.includes("Lot not found for adjustment")) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Failed to create order" }, { status: 500 });
  }
}
