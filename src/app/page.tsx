import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import ThemeToggle from "@/components/header/ThemeToggle";
import { ShoppingBag, Phone, Boxes } from "lucide-react";
import { ADMIN_PHONE } from "@/lib/config";
import { prisma } from "@/lib/prisma";
import ProductCard from "@/app/(shop)/products/ProductCard";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";

export default async function HomePage() {
  const session = await getServerSession(authOptions);
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
    price: Number(p.price),
    createdAt: p.createdAt.toISOString(),
    stock: p.stock,
  }));

  return (
    <main className="min-h-screen flex flex-col items-center justify-center text-center p-6">
      <section className="max-w-5xl w-full">
        <div className="flex flex-col items-center gap-4 text-center px-2">
          <Image src="/logo.svg" alt="Noralls Medical Supplies Logo" width={140} height={140} className="w-32 sm:w-40 h-auto" />
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight leading-tight">Welcome to Noralls Medical Supplies</h1>
          <p className="text-muted-foreground max-w-xl text-base sm:text-lg">
            Your trusted source for hospital and clinical supplies. Browse our wide range of professional
            products — from thermometers to gloves — and enjoy quick, reliable service.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 mt-4 w-full sm:w-auto">
            <Link href="/products" className="w-full sm:w-auto">
              <Button size="lg" className="flex items-center justify-center gap-2 w-full">
                <ShoppingBag className="h-5 w-5" /> Shop Now
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
        </div>

        <section className="mt-12">
          <h2 className="text-2xl font-semibold mb-4">Featured Products</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {safeFeatured.map((p: (typeof safeFeatured)[number]) => (
              <ProductCard
                key={p.id}
                id={p.id}
                name={p.name}
                description={p.description}
                imageUrl={p.imageUrl}
                price={p.price}
                isNew={(() => { try { return (Date.now() - Date.parse(p.createdAt)) < 1000*60*60*24*30 } catch { return false } })()}
                inStock={typeof p.stock === 'number' ? p.stock > 0 : true}
                lowStock={typeof p.stock === 'number' ? p.stock > 0 && p.stock <= 3 : false}
                variant="auto"
              />
            ))}
          </div>
          <div className="text-center mt-6">
            <Link href="/products">
              <Button size="sm" variant="secondary">Browse All Products</Button>
            </Link>
          </div>
        </section>

        <Card className="mt-10 p-6 !rounded-none !border-none shadow-md">
          <CardContent className="grid gap-4">
            <h2 className="text-xl font-semibold">Why Choose Noralls?</h2>
            <ul className="text-left list-disc list-inside space-y-1">
              <li>Quality medical products for clinics, hospitals, and home care.</li>
              <li>Transparent pricing with no hidden fees.</li>
              <li>
                Dedicated support — call <strong>{ADMIN_PHONE}</strong> to arrange payment.
              </li>
              <li>Secure customer accounts with order tracking and real-time cart updates.</li>
            </ul>
          </CardContent>
        </Card>

        <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4 sm:gap-6 text-sm text-muted-foreground text-center">
          <ThemeToggle />
          <div className="flex items-center gap-1">
            <Phone className="h-4 w-4" /> {ADMIN_PHONE}
          </div>
        </div>
      </section>
    </main>
  );
}
