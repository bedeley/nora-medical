import { readFile } from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

type GuideSection = {
  title: string;
  body: string;
};

async function loadGuide() {
  const guidePath = path.join(process.cwd(), "docs", "admin-guide.text");
  try {
    return await readFile(guidePath, "utf8");
  } catch {
    return "Admin guide not found. Expected docs/admin-guide.text.";
  }
}

function parseGuide(content: string) {
  const lines = content.split(/\r?\n/);
  const firstNonEmpty = lines.find((line) => line.trim()) || "Admin Guide";
  const title = firstNonEmpty;
  const introLines: string[] = [];
  const sections: GuideSection[] = [];
  let current: GuideSection | null = null;
  let pastTitle = false;

  for (const line of lines) {
    if (!pastTitle) {
      if (line.trim() === title.trim()) {
        pastTitle = true;
      }
      continue;
    }
    if (line.startsWith("## ")) {
      if (current) sections.push(current);
      current = { title: line.replace(/^##\s+/, "").trim(), body: "" };
      continue;
    }
    if (current) {
      current.body += (current.body ? "\n" : "") + line;
    } else if (line.trim()) {
      introLines.push(line);
    }
  }
  if (current) sections.push(current);

  return {
    title,
    intro: introLines.join("\n").trim(),
    sections,
  };
}

export default async function AdminGuidePage() {
  const content = await loadGuide();
  const guide = parseGuide(content);

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{guide.title || "Admin Guide"}</h1>
        {guide.intro ? (
          <p className="text-sm text-muted-foreground whitespace-pre-line">
            {guide.intro}
          </p>
        ) : null}
      </div>
      <div className="space-y-3">
        {guide.sections.map((section) => (
          <details
            key={section.title}
            className="rounded-md border bg-card px-4 py-3 shadow-sm"
          >
            <summary className="cursor-pointer font-semibold">
              {section.title}
            </summary>
            <div className="mt-2">
              <pre className="whitespace-pre-wrap text-sm leading-6">
                {section.body.trim() || "No details provided yet."}
              </pre>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
