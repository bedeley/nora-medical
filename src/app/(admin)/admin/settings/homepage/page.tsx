"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type HomepageSettingsResponse = {
  collage: string[];
  defaults: string[];
  error?: string;
};

const allowedUrlHint =
  "Use uploads or an approved Cloudflare R2 public URL.";

export default function HomepageSettingsPage() {
  const [collage, setCollage] = useState<string[]>(["", "", ""]);
  const [defaults, setDefaults] = useState<string[]>(["", "", ""]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadingIndex, setUploadingIndex] = useState<number | null>(null);
  const canSave = collage.every((url) => String(url || "").trim().length > 0);

  const load = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/admin/settings/homepage");
      const data = (await res.json().catch(() => ({}))) as HomepageSettingsResponse;
      if (!res.ok) throw new Error(data?.error || "Failed to load settings");
      setCollage(Array.isArray(data.collage) ? data.collage : ["", "", ""]);
      setDefaults(Array.isArray(data.defaults) ? data.defaults : ["", "", ""]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to load settings";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleUpload = async (index: number, file: File | null) => {
    if (!file) return;
    try {
      setUploadingIndex(index);
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data?.url) {
        throw new Error(data?.error || "Upload failed");
      }
      setCollage((prev) => {
        const next = [...prev];
        next[index] = data.url || "";
        return next;
      });
      toast.success("Image uploaded");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Upload failed";
      toast.error(msg);
    } finally {
      setUploadingIndex(null);
    }
  };

  const save = async () => {
    try {
      setSaving(true);
      const res = await fetch("/api/admin/settings/homepage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collage }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data?.error || "Failed to save settings");
      toast.success("Homepage collage updated");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to save settings";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const resetToDefaults = () => {
    if (!defaults.length) return;
    setCollage(defaults);
  };

  return (
    <div className="container mx-auto py-8 max-w-4xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Homepage Hero Collage</h1>
        <p className="text-sm text-muted-foreground">
          Upload or paste three images for the hero collage on the homepage.
        </p>
      </header>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Collage Images</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading settings…</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {collage.map((url, index) => (
                <div key={index} className="rounded-lg border p-3 space-y-3">
                  <div className="text-xs font-medium text-muted-foreground">
                    Image {index + 1}
                  </div>
                  <div className="aspect-[4/3] w-full rounded-md border bg-muted/20 flex items-center justify-center overflow-hidden">
                    {url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={url} alt={`Collage ${index + 1}`} className="h-full w-full object-contain" />
                    ) : (
                      <span className="text-xs text-muted-foreground">No image selected</span>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`collage-${index}`} className="text-xs">
                      Image URL
                    </Label>
                    <Input
                      id={`collage-${index}`}
                      value={url}
                      onChange={(e) => {
                        const next = e.target.value;
                        setCollage((prev) => {
                          const updated = [...prev];
                          updated[index] = next;
                          return updated;
                        });
                      }}
                      placeholder="https://..."
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {allowedUrlHint}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`file-${index}`} className="text-xs">
                      Upload new image
                    </Label>
                    <Input
                      id={`file-${index}`}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(e) => handleUpload(index, e.target.files?.[0] ?? null)}
                      disabled={uploadingIndex === index}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={save} disabled={saving || loading || !canSave}>
              {saving ? "Saving..." : "Save changes"}
            </Button>
            <Button type="button" variant="outline" onClick={resetToDefaults} disabled={!defaults.length || loading}>
              Reset to defaults
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Recommended: 1200×900 for the square tiles and 1600×700 for the wide tile.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
