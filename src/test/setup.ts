import { expect, afterEach } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";

expect.extend(matchers);

// Auto-cleanup RTL renders after each test (required when globals: false)
afterEach(cleanup);
