import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import ThemeToggle from "@/components/header/ThemeToggle";
import { ShoppingBag, Phone, Boxes, Package, ShieldCheck, ClipboardList } from "lucide-react";
import { ADMIN_PHONE } from "@/lib/config";
import { prisma } from "@/lib/prisma";
import ProductCard from "@/app/(shop)/products/ProductCard";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { PRODUCT_CATEGORY_LABELS } from "@/lib/product-categories";
import { getHeroCollageImages } from "@/lib/homepage-settings";

export default async function HomePage() {
  const session = await getServerSession(authOptions);
  const heroCollage = await getHeroCollageImages();
  const featured = await prisma.product.findMany({
    where: { archived: false },
    orderBy: { createdAt: "desc" },
    take: 8,
  });

  const safeFeatured = featured.map((p: (typeof featured)[number]) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    imageUrl: p.imageUrl,
    category: p.category ?? null,
    brand: p.brand ?? null,
    supplier: p.supplier ?? null,
    price: Number(p.price),
    createdAt: p.createdAt.toISOString(),
    stock: p.stock,
  }));

  return (
    <main className="min-h-screen flex flex-col items-center justify-start text-center px-6 pt-10 pb-16 relative overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-teal-100/60 to-transparent" />
      <section className="max-w-6xl w-full">
        <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] items-center text-center lg:text-left">
          <div className="flex flex-col gap-5 items-center lg:items-start px-2">
            <div className="flex items-center gap-2 sm:gap-3 flex-nowrap">
              <Image
                src="/logo.svg"
                alt="Noralls Medical Supplies Logo"
                width={120}
                height={120}
                className="w-12 sm:w-20 md:w-24 h-auto"
              />
              <Badge variant="secondary" className="text-[10px] sm:text-sm whitespace-nowrap px-2 py-1">
                Clinic-ready supply partner
              </Badge>
            </div>
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight leading-tight">
              Everything your clinic needs, delivered with speed and care.
            </h1>
            <p className="text-muted-foreground max-w-xl text-base sm:text-lg">
              Noralls Medical Supplies helps hospitals, clinics, and home-care teams stock trusted essentials.
              Shop verified products, transparent pricing, and fast local support.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 mt-2 w-full sm:w-auto">
              <Link href="/products" className="w-full sm:w-auto">
                <Button size="lg" className="flex items-center justify-center gap-2 w-full">
                  <ShoppingBag className="h-5 w-5" /> Shop Products
                </Button>
              </Link>
              <Link href="/contact" className="w-full sm:w-auto">
                <Button size="lg" variant="secondary" className="flex items-center justify-center gap-2 w-full">
                  Request a quote
                </Button>
              </Link>
              <Link href="/contact" className="w-full sm:w-auto">
                <Button variant="outline" size="lg" className="flex items-center justify-center gap-2 w-full">
                  Talk to sales
                </Button>
              </Link>
              {(session?.user as AuthenticatedUser | null)?.role === "ADMIN" && (
                <>
                  <Link href="/admin/inventory" className="w-full sm:w-auto">
                    <Button variant="outline" size="lg" className="flex items-center justify-center gap-2 w-full">
                      <Boxes className="h-5 w-5" /> View Inventory
                    </Button>
                  </Link>
                  <Badge variant="secondary">Admin</Badge>
                </>
              )}
              {!session && (
                <div className="flex flex-col gap-2 w-full md:hidden">
                  <Link href="/login" className="w-full">
                    <Button variant="outline" size="lg" className="w-full">
                      Login
                    </Button>
                  </Link>
                  <Link href="/register" className="w-full">
                    <Button variant="outline" size="lg" className="w-full">
                      Create Account
                    </Button>
                  </Link>
                </div>
              )}
            </div>
            <div className="flex flex-wrap justify-center lg:justify-start gap-3 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 shadow-sm">
                <ShieldCheck className="h-4 w-4 text-primary" /> Verified suppliers
              </span>
              <span className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 shadow-sm">
                <ClipboardList className="h-4 w-4 text-primary" /> Transparent pricing
              </span>
              <span className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 shadow-sm">
                <Package className="h-4 w-4 text-primary" /> Fast local delivery
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Most orders ship within 24 hours. Delivery times vary by location.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border bg-white p-4 shadow-lg">
              <Image
                src={heroCollage[0] || "/uploads/4732787a-8d0a-4ec9-94d9-dd57cca82e3c.jpg"}
                alt="Mobility equipment"
                width={320}
                height={320}
                className="w-full h-48 object-contain"
              />
              <p className="mt-3 text-sm font-medium text-foreground">Mobility &amp; rehab</p>
            </div>
            <div className="rounded-2xl border bg-white p-4 shadow-lg">
              <Image
                src={heroCollage[1] || "/uploads/2abbfb58-7c4f-4b02-9726-0a148eddfca9.jpg"}
                alt="Respiratory supplies"
                width={320}
                height={320}
                className="w-full h-48 object-contain"
              />
              <p className="mt-3 text-sm font-medium text-foreground">Respiratory care</p>
            </div>
            <div className="rounded-2xl border bg-white p-4 shadow-lg sm:col-span-2">
              <Image
                src={heroCollage[2] || "/uploads/9c57f011-cafc-494e-b44e-1b6fcfd4b231.jpg"}
                alt="Clinical disposables"
                width={640}
                height={320}
                className="w-full h-44 object-contain"
              />
              <p className="mt-3 text-sm font-medium text-foreground">Clinical disposables</p>
            </div>
          </div>
        </div>

        <section className="mt-14">
          <div className="flex flex-col items-center gap-3 text-center">
            <h2 className="text-2xl sm:text-3xl font-semibold">Shop by category</h2>
            <p className="text-muted-foreground max-w-2xl text-sm sm:text-base">
              Quickly jump into the supplies teams order most often. Every category is curated for clinical-grade quality.
            </p>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { value: "diagnostics", helper: "Thermometers, monitors, kits", icon: ClipboardList },
              { value: "mobility", helper: "Wheelchairs, walkers, supports", icon: Package },
              { value: "ppe-safety", helper: "Masks, gloves, gowns", icon: ShieldCheck },
              { value: "equipment", helper: "Devices & tools", icon: Boxes },
            ].map((item) => (
              <Link
                key={item.value}
                href={`/products?category=${encodeURIComponent(item.value)}`}
                className="rounded-2xl border bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
              >
                <item.icon className="h-6 w-6 text-primary" />
                <p className="mt-3 font-semibold">{PRODUCT_CATEGORY_LABELS[item.value as keyof typeof PRODUCT_CATEGORY_LABELS]}</p>
                <p className="text-sm text-muted-foreground">{item.helper}</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="mt-12">
          <div className="flex flex-col items-center gap-2 text-center">
            <h2 className="text-2xl sm:text-3xl font-semibold">Featured products</h2>
            <p className="text-muted-foreground text-sm sm:text-base max-w-xl">
              New arrivals and best sellers curated for busy care teams.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {safeFeatured.map((p: (typeof safeFeatured)[number]) => (
              <ProductCard
                key={p.id}
                id={p.id}
                name={p.name}
                description={p.description}
                imageUrl={p.imageUrl}
                category={p.category ?? undefined}
                brand={p.brand ?? undefined}
                price={p.price}
                isNew={(() => { try { return (Date.now() - Date.parse(p.createdAt)) < 1000*60*60*24*30 } catch { return false } })()}
                inStock={typeof p.stock === 'number' ? p.stock > 0 : true}
                lowStock={typeof p.stock === 'number' ? p.stock > 0 && p.stock <= 3 : false}
                variant="mini"
              />
            ))}
          </div>
          <div className="text-center mt-6">
            <Link href="/products">
              <Button size="sm" variant="secondary">Browse all products</Button>
            </Link>
          </div>
        </section>

        <section className="mt-12">
          <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
            <div className="rounded-2xl border bg-white p-6 text-left shadow-sm">
              <p className="text-sm uppercase tracking-wide text-muted-foreground">Customer note</p>
              <p className="mt-3 text-lg font-semibold">
                &ldquo;Noralls helped us standardize our clinic stock in weeks. Orders are accurate, and support is fast.&rdquo;
              </p>
              <p className="mt-3 text-sm text-muted-foreground">Procurement Lead, Regional Health Facility</p>
            </div>
            <div className="rounded-2xl border bg-white p-6 shadow-sm">
              <p className="text-sm uppercase tracking-wide text-muted-foreground">Trusted by facilities</p>
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm font-semibold text-foreground/70">
                <div className="rounded-lg border border-dashed px-3 py-4 text-center">CityCare Clinic</div>
                <div className="rounded-lg border border-dashed px-3 py-4 text-center">Nora General</div>
                <div className="rounded-lg border border-dashed px-3 py-4 text-center">Unity Health</div>
                <div className="rounded-lg border border-dashed px-3 py-4 text-center">Lakeside Labs</div>
              </div>
            </div>
          </div>
        </section>

        <Card className="mt-12 p-6 !rounded-none !border-none shadow-md">
          <CardContent className="grid gap-6">
            <div className="text-center">
              <h2 className="text-xl sm:text-2xl font-semibold">Why teams choose Noralls</h2>
              <p className="text-sm text-muted-foreground mt-2">
                Reliable sourcing, responsive support, and a checkout flow built for clinical teams.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 text-left">
              <div className="rounded-xl border bg-white p-4">
                <p className="font-semibold">Clinician-approved stock</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Curated products suited for hospital, clinic, and home-care workflows.
                </p>
              </div>
              <div className="rounded-xl border bg-white p-4">
                <p className="font-semibold">Pricing you can trust</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Clear pricing with no surprises, plus transparent invoices.
                </p>
              </div>
              <div className="rounded-xl border bg-white p-4">
                <p className="font-semibold">Dedicated support</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Call <strong>{ADMIN_PHONE}</strong> for sourcing or payment help.
                </p>
              </div>
              <div className="rounded-xl border bg-white p-4">
                <p className="font-semibold">Secure accounts</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Track orders, manage balances, and keep purchasing streamlined.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <section className="mt-10">
          <Card className="p-6 shadow-sm">
            <CardContent className="grid gap-4 sm:grid-cols-[1.2fr_0.8fr] items-center">
              <div className="text-left">
                <h3 className="text-lg font-semibold">Need help placing a bulk order?</h3>
                <p className="text-sm text-muted-foreground mt-2">
                  Our team can build a tailored quote and confirm stock availability for your facility.
                </p>
              </div>
              <div className="flex flex-col gap-2 text-sm">
                <div className="flex items-center gap-2 font-medium">
                  <Phone className="h-4 w-4 text-primary" /> {ADMIN_PHONE}
                </div>
                <span className="text-xs text-muted-foreground">Mon-Fri, 9am-5pm local time</span>
                <Link href="/contact" className="text-sm font-semibold text-primary underline-offset-4 hover:underline">
                  Contact support
                </Link>
              </div>
            </CardContent>
          </Card>
        </section>

        <div className="mt-12 flex flex-col sm:flex-row items-center justify-center gap-4 sm:gap-6 text-sm text-muted-foreground text-center">
          <ThemeToggle />
          <div className="flex items-center gap-1">
            <Phone className="h-4 w-4" /> {ADMIN_PHONE}
          </div>
        </div>
      </section>
    </main>
  );
}
