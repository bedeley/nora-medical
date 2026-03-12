import { Suspense } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import InviteClient from "./InviteClient";

export default function InvitePage() {
  return (
    <Suspense fallback={<InviteFallback />}>
      <InviteClient />
    </Suspense>
  );
}

function InviteFallback() {
  return (
    <main className="min-h-screen bg-muted/40 flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-lg">Employee invite</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading invite details...</p>
        </CardContent>
      </Card>
    </main>
  );
}
