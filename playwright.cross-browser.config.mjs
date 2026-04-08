import { defineConfig, devices } from "@playwright/test";
import baseConfig from "./playwright.config.mjs";

export default defineConfig({
  ...baseConfig,
  workers: 1,
  fullyParallel: false,
  projects: [
    {
      name: "desktop-chrome",
      use: {
        ...baseConfig.use,
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "desktop-firefox",
      use: {
        ...baseConfig.use,
        ...devices["Desktop Firefox"],
      },
    },
    {
      name: "desktop-safari",
      use: {
        ...baseConfig.use,
        ...devices["Desktop Safari"],
      },
    },
    {
      name: "iphone-13",
      use: {
        ...baseConfig.use,
        ...devices["iPhone 13"],
      },
    },
    {
      name: "pixel-7",
      use: {
        ...baseConfig.use,
        ...devices["Pixel 7"],
      },
    },
  ],
});
