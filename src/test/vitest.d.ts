import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  // Extends Vitest's expect with @testing-library/jest-dom matchers
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Assertion<R = unknown> extends TestingLibraryMatchers<R, void> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, void> {}
}
