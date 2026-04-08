import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    // Keep Vitest opt-in during migration; legacy node:test files stay untouched.
    // Files with @vitest-environment jsdom override to browser-like environment.
    include: ["src/**/*.vitest.test.ts", "src/**/*.vitest.spec.ts", "src/**/*.vitest.spec.tsx"],
    setupFiles: ["src/test/setup.ts"],
    globals: false,
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage/vitest",
      include: ["src/lib/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.vitest.spec.ts", "src/**/*.vitest.spec.tsx", "src/**/*.vitest.test.ts", "src/test/**"],
    },
  },
});
