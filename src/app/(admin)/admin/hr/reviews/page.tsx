import { Suspense } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import ReviewsClient from "./ReviewsClient";

export const dynamic = "force-dynamic";

export default function ReviewsPage() {
  return (
    <Suspense fallback={<ReviewsFallback />}>
      <ReviewsClient />
    </Suspense>
  );
}

function ReviewsFallback() {
  return (
    <section className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Performance Reviews</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading reviews...</p>
        </CardContent>
      </Card>
    </section>
  );
}
