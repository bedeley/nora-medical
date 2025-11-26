import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

// Helper to get dates N days ago
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

async function main() {
  // Clean database (order matters due to FKs)
  await prisma.$transaction([
    prisma.inventoryMovement.deleteMany({}),
    prisma.purchase.deleteMany({}),
    prisma.orderItem.deleteMany({}),
    prisma.payment.deleteMany({}),
    prisma.order.deleteMany({}),
    prisma.cartItem.deleteMany({}),
    prisma.cart.deleteMany({}),
    prisma.balance.deleteMany({}),
    prisma.account.deleteMany({}),
    prisma.session.deleteMany({}),
  ]);

  // Users
  const passwordAdmin = await bcrypt.hash("Admin!234", 10);
  const passwordUser = await bcrypt.hash("Passw0rd!", 10);

  const [admin, mercy, kwame, ama] = await Promise.all([
    prisma.user.upsert({
      where: { email: "admin@nora.local" },
      update: {},
      create: {
        email: "admin@nora.local",
        name: "System Admin",
        password: passwordAdmin,
        role: Role.ADMIN,
      },
    }),
    prisma.user.upsert({
      where: { email: "mercy.owusu@example.com" },
      update: {},
      create: {
        email: "mercy.owusu@example.com",
        name: "Mercy Owusu",
        password: passwordUser,
        role: Role.CUSTOMER,
        phone: "+233200000001",
      },
    }),
    prisma.user.upsert({
      where: { email: "kwame.boateng@example.com" },
      update: {},
      create: {
        email: "kwame.boateng@example.com",
        name: "Kwame Boateng",
        password: passwordUser,
        role: Role.CUSTOMER,
        phone: "+233200000002",
      },
    }),
    prisma.user.upsert({
      where: { email: "ama.mensah@example.com" },
      update: {},
      create: {
        email: "ama.mensah@example.com",
        name: "Ama Mensah",
        password: passwordUser,
        role: Role.CUSTOMER,
        phone: "+233200000003",
      },
    }),
  ]);
  console.info(`Admin user ready: ${admin.email}`);

  // Products (realistic images from Unsplash)
  const productsData = [
    {
      name: "Nitrile Exam Gloves (100 pcs)",
      description: "Powder-free, latex-free nitrile examination gloves for medical use.",
      imageUrl:
        "https://images.unsplash.com/photo-1580281657527-47a74d68c5b1?q=80&w=1080&auto=format&fit=crop",
      price: 12.0,
      cost: 6.0,
    },
    {
      name: "Surgical Masks (50 pcs)",
      description: "3-ply disposable surgical masks with ear loops.",
      imageUrl:
        "https://images.unsplash.com/photo-1583416750391-7f5d4a4b1f5b?q=80&w=1080&auto=format&fit=crop",
      price: 10.0,
      cost: 4.0,
    },
    {
      name: "Disposable Syringes 5ml (100 pcs)",
      description: "Sterile, single-use syringes with Luer lock.",
      imageUrl:
        "https://images.unsplash.com/photo-1576765607935-3b63babc1d96?q=80&w=1080&auto=format&fit=crop",
      price: 18.0,
      cost: 9.0,
    },
    {
      name: "Alcohol Prep Pads (200 pcs)",
      description: "70% isopropyl alcohol swabs for skin preparation.",
      imageUrl:
        "https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?q=80&w=1080&auto=format&fit=crop",
      price: 7.5,
      cost: 3.2,
    },
    {
      name: "IV Starter Kit",
      description: "Comprehensive IV starter kit for clinical use.",
      imageUrl:
        "https://images.unsplash.com/photo-1582719478250-54b384b82106?q=80&w=1080&auto=format&fit=crop",
      price: 28.0,
      cost: 17.0,
    },
    {
      name: "Sterile Gauze Pads (100)",
      description: "Individually wrapped sterile gauze pads, 4x4 in.",
      imageUrl:
        "https://images.unsplash.com/photo-1581594693700-88c9b31f9e22?q=80&w=1080&auto=format&fit=crop",
      price: 9.0,
      cost: 4.5,
    },
    {
      name: "Digital Thermometer",
      description: "Fast-reading digital thermometer with flexible tip.",
      imageUrl:
        "https://images.unsplash.com/photo-1582719478250-cdf44f07f657?q=80&w=1080&auto=format&fit=crop",
      price: 14.0,
      cost: 7.5,
    },
    {
      name: "Stethoscope",
      description: "Dual head stethoscope for general exam.",
      imageUrl:
        "https://images.unsplash.com/photo-1580281657527-973c11472edb?q=80&w=1080&auto=format&fit=crop",
      price: 39.0,
      cost: 22.0,
    },
    {
      name: "Blood Pressure Monitor",
      description: "Upper arm automatic BP monitor with cuff.",
      imageUrl:
        "https://images.unsplash.com/photo-1579154204601-01588f351e67?q=80&w=1080&auto=format&fit=crop",
      price: 55.0,
      cost: 34.0,
    },
    {
      name: "Wheelchair",
      description: "Folding lightweight wheelchair with footrests.",
      imageUrl:
        "https://images.unsplash.com/photo-1582719478250-75a6c0f211cd?q=80&w=1080&auto=format&fit=crop",
      price: 220.0,
      cost: 150.0,
    },
    {
      name: "Hospital Bed",
      description: "Manual adjustable hospital bed with side rails.",
      imageUrl:
        "https://images.unsplash.com/photo-1582719478250-67b9f4c3c0cf?q=80&w=1080&auto=format&fit=crop",
      price: 680.0,
      cost: 490.0,
    },
    {
      name: "Pulse Oximeter",
      description: "Finger pulse oximeter with OLED display.",
      imageUrl:
        "https://images.unsplash.com/photo-1582719478250-0fdc9b3e7c8a?q=80&w=1080&auto=format&fit=crop",
      price: 24.0,
      cost: 12.0,
    },
  ];

  const products = await Promise.all(
    productsData.map((p) =>
      prisma.product.create({
        data: {
          name: p.name,
          description: p.description,
          imageUrl: p.imageUrl,
          price: p.price,
          cost: p.cost,
          stock: 0, // will be updated after movements
        },
      })
    )
  );

  const suppliers = [
    "Medline",
    "Cardinal Health",
    "McKesson",
    "3M",
    "Becton Dickinson",
    "Johnson & Johnson",
  ];

  // Create purchases and stock increases (movements)
  const purchases = [] as { id: string; productId: string; quantity: number; unitCost: number }[];
  for (const [idx, product] of products.entries()) {
    // 2-3 purchases per product over the last 90 days
    const batches = [
      { qty: 50 + (idx % 4) * 25, days: 75, unitCost: Number(productsData[idx].cost) },
      { qty: 40 + (idx % 3) * 20, days: 45, unitCost: Number(productsData[idx].cost) * 1.05 },
      { qty: 30 + (idx % 2) * 15, days: 15, unitCost: Number(productsData[idx].cost) * 0.97 },
    ];
    for (const [i, b] of batches.entries()) {
      const purchase = await prisma.purchase.create({
        data: {
          productId: product.id,
          quantity: b.qty,
          unitCost: b.unitCost.toFixed ? Number(b.unitCost.toFixed(2)) : b.unitCost,
          supplier: suppliers[(idx + i) % suppliers.length],
          note: "Stock replenishment",
          createdAt: daysAgo(b.days),
        },
      });
      purchases.push({ id: purchase.id, productId: product.id, quantity: b.qty, unitCost: Number(b.unitCost) });
      await prisma.inventoryMovement.create({
        data: {
          productId: product.id,
          delta: b.qty,
          reason: "PURCHASE",
          purchaseId: purchase.id,
          createdAt: daysAgo(b.days),
        },
      });
    }
  }

  // Create some sale movements independent of orders (walk-ins, adjustments)
  for (const product of products) {
    const sale1 = -1 * (3 + (product.id.charCodeAt(0) % 5));
    await prisma.inventoryMovement.create({
      data: {
        productId: product.id,
        delta: sale1,
        reason: "SALE",
        createdAt: daysAgo(10),
      },
    });
    const sale2 = -1 * (2 + (product.id.charCodeAt(1) % 4));
    await prisma.inventoryMovement.create({
      data: {
        productId: product.id,
        delta: sale2,
        reason: "SALE",
        createdAt: daysAgo(5),
      },
    });
  }

  // Orders for each customer with items
  const productByName = Object.fromEntries(products.map((p) => [p.name, p]));

  const makeOrder = async (
    userId: string,
    items: { name: string; qty: number }[],
    days: number,
    paid: number,
    delivered = true
  ) => {
    const createdAt = daysAgo(days);
    const orderItems = items.map((it) => {
      const prod = productByName[it.name];
      const unitPrice = Number(productsData.find((d) => d.name === it.name)!.price);
      const costAtSale = Number(productsData.find((d) => d.name === it.name)!.cost);
      return {
        productId: prod.id,
        quantity: it.qty,
        price: unitPrice,
        costAtSale,
      };
    });
    const total = orderItems.reduce((s, oi) => s + Number(oi.price) * oi.quantity, 0);
    const amountPaid = Math.min(paid, total);
    const balance = Number((total - amountPaid).toFixed(2));

    const order = await prisma.order.create({
      data: {
        userId,
        total,
        amountPaid,
        balance,
        status: balance > 0 ? "UNPAID" : "PAID",
        deliveryStatus: delivered ? "DELIVERED" : "NOT_DELIVERED",
        deliveredAt: delivered ? createdAt : null,
        createdAt,
        items: { createMany: { data: orderItems } },
      },
      include: { items: true },
    });

    // Record a payment if any
    if (amountPaid > 0) {
      await prisma.payment.create({
        data: {
          userId,
          orderId: order.id,
          amount: amountPaid,
          note: "Customer payment",
          createdAt,
        },
      });
    }

    // Also reflect stock decreases for this order (SALE movements)
    for (const it of order.items) {
      await prisma.inventoryMovement.create({
        data: {
          productId: it.productId,
          delta: -it.quantity,
          reason: "SALE",
          createdAt,
        },
      });
    }

    return order;
  };

  // Sample orders per customer
  await makeOrder(
    mercy.id,
    [
      { name: "Nitrile Exam Gloves (100 pcs)", qty: 3 },
      { name: "Surgical Masks (50 pcs)", qty: 4 },
      { name: "Digital Thermometer", qty: 1 },
    ],
    20,
    40,
    true
  );

  await makeOrder(
    mercy.id,
    [
      { name: "Sterile Gauze Pads (100)", qty: 2 },
      { name: "Disposable Syringes 5ml (100 pcs)", qty: 1 },
    ],
    7,
    0,
    false
  );

  await makeOrder(
    kwame.id,
    [
      { name: "Stethoscope", qty: 1 },
      { name: "Blood Pressure Monitor", qty: 1 },
      { name: "Pulse Oximeter", qty: 2 },
    ],
    30,
    60,
    true
  );

  await makeOrder(
    kwame.id,
    [
      { name: "Alcohol Prep Pads (200 pcs)", qty: 3 },
      { name: "IV Starter Kit", qty: 1 },
    ],
    3,
    0,
    false
  );

  await makeOrder(
    ama.id,
    [
      { name: "Wheelchair", qty: 1 },
      { name: "Surgical Masks (50 pcs)", qty: 2 },
    ],
    12,
    150,
    true
  );

  // Update product stock based on movements (sum of deltas)
  for (const product of products) {
    const agg = await prisma.inventoryMovement.aggregate({
      where: { productId: product.id },
      _sum: { delta: true },
    });
    const stock = Number(agg._sum.delta || 0);
    // Update stock
    await prisma.product.update({ where: { id: product.id }, data: { stock } });
  }

  // Update product cost with latest purchase price per product
  for (const product of products) {
    const last = await prisma.purchase.findFirst({
      where: { productId: product.id },
      orderBy: { createdAt: "desc" },
    });
    if (last) {
      await prisma.product.update({ where: { id: product.id }, data: { cost: Number(last.unitCost) } });
    }
  }

  // Balances per user
  for (const u of [mercy, kwame, ama]) {
    const orders = await prisma.order.findMany({ where: { userId: u.id } });
    const totalDue = orders.reduce((s, o) => s + Number(o.total), 0);
    const totalPaid = orders.reduce((s, o) => s + Number(o.amountPaid), 0);
    const balance = Number((totalDue - totalPaid).toFixed(2));
    await prisma.balance.upsert({
      where: { userId: u.id },
      update: { totalDue, totalPaid, balance },
      create: { userId: u.id, totalDue, totalPaid, balance },
    });
  }

  // A couple of expenses for reports
  await prisma.expense.createMany({
    data: [
      { category: "Logistics", amount: 120.5, note: "Local delivery", createdAt: daysAgo(14) },
      { category: "Utilities", amount: 85.25, note: "Power & water", createdAt: daysAgo(9) },
    ],
  });

  console.log("Seed completed: users, products, purchases, movements, orders, payments, balances, expenses.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
