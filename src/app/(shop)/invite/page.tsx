import { Suspense } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
    <div className="min-h-screen bg-muted/40 flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <h1 className="text-lg font-semibold">Employee invite</h1>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading invite details...</p>
        </CardContent>
      </Card>
    </div>
  );
}
