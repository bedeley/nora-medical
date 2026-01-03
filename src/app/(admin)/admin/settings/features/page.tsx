"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

type FeatureRow = {
  key: string;
  label: string;
  envEnabled: boolean;
  dbEnabled?: boolean;
  effective: boolean;
};

type FeaturesResponse = {
  features: FeatureRow[];
};

const fetcher = async (): Promise<FeaturesResponse> => {
  const r = await fetch("/api/admin/settings/features");
  const j = (await r.json().catch(() => ({}))) as FeaturesResponse & { error?: string };
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j;
};

export default function FeatureSettingsPage() {
  const [data, setData] = useState<FeaturesResponse | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    try {
      const j = await fetcher();
      setData(j);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to load features";
      toast.error(msg);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggleFeature(row: FeatureRow) {
    try {
      setLoading(true);
      const res = await fetch("/api/admin/settings/features", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: row.key, enabled: !row.effective }),
      });
      const j = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) {
        throw new Error(j?.error || "Failed to update feature");
      }
      toast.success("Feature updated");
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to update feature";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  const rows = data?.features || [];

  return (
    <div className="container mx-auto py-8 max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Feature Toggles</h1>
        <p className="text-sm text-muted-foreground">
          Enable or pause features without redeploying.
        </p>
      </header>
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            These toggles sit on top of environment variables. If an env var is off, the feature
            cannot be enabled here. When env allows it, you can temporarily pause features without
            redeploying.
          </p>
          {rows.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              <p>{loading ? "Loading features…" : "No configurable features found."}</p>
              {!loading && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={load}>
                    Refresh
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="grid gap-3">
              {rows.map((row) => {
                const envBlocked = !row.envEnabled;
                return (
                  <div
                    key={row.key}
                    className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border rounded-md px-3 py-2"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{row.label}</span>
                        <Badge variant={row.effective ? "default" : "secondary"}>
                          {row.effective ? "On" : "Off"}
                        </Badge>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-1">
                        Env: {row.envEnabled ? "ENABLED" : "DISABLED"} · Override:{" "}
                        {row.dbEnabled === undefined
                          ? "none"
                          : row.dbEnabled
                          ? "enabled"
                          : "disabled"}
                      </p>
                      {envBlocked && (
                        <p className="text-[11px] text-red-700">
                          This feature is disabled at the environment level; toggling here will have
                          no effect until the env var is enabled.
                        </p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant={row.effective ? "outline" : "secondary"}
                      disabled={loading || envBlocked}
                      onClick={() => toggleFeature(row)}
                    >
                      {row.effective ? "Turn off" : "Turn on"}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
