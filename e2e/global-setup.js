import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = path.join(__dirname, ".auth", "admin.json");

/**
 * Global setup: log in as admin once and save the session state.
 * All tests that use storageState: AUTH_FILE skip the per-test login,
 * avoiding the 5-logins/60s rate limit in auth.ts.
 */
export default async function globalSetup() {
  const email = process.env.E2E_ADMIN_EMAIL || "";
  const password = process.env.E2E_ADMIN_PASSWORD || "";
  const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";

  if (!email || !password) {
    console.warn("[global-setup] E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD not set; skipping admin auth setup.");
    return;
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.goto("/login?callbackUrl=/admin");
      if (!page.url().includes("/login")) break;
      await page.getByPlaceholder(/email or username/i).fill(email);
      await page.getByPlaceholder(/^password$/i).fill(password);
      await page.getByRole("button", { name: /sign in|login/i }).click();
      await page.waitForLoadState("networkidle");
      if (!page.url().includes("/login")) break;
      await page.waitForTimeout(1000);
    }

    if (page.url().includes("/login")) {
      console.warn("[global-setup] Admin login did not complete — rate limited or wrong credentials? Tests requiring auth will fall back to per-test login.");
    } else {
      console.log("[global-setup] Admin session saved to", AUTH_FILE);
    }
    // Always save state (even if empty/unauthenticated) so test.use({ storageState }) never throws
    await context.storageState({ path: AUTH_FILE });
  } finally {
    await browser.close();
  }
}
