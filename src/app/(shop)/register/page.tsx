"use client";

import { useRouter } from "next/navigation";
import RegisterForm from "@/components/forms/RegisterForm";
import Link from "next/link";

export default function RegisterPage() {
  const router = useRouter();
  return (
    <section className="container mx-auto max-w-sm py-12">
      <h1 className="text-2xl font-semibold mb-6">Create account</h1>
      <p className="text-xs text-muted-foreground mb-4">
        Note: The first account can become an admin only when created with the admin bootstrap secret. All subsequent accounts are customers.
      </p>
      <RegisterForm onSuccess={() => router.push("/login")} />
      <p className="text-sm text-muted-foreground mt-4">
        Already have an account? {" "}
        <Link href="/login" className="underline">Sign in</Link>
      </p>
    </section>
  );
}
