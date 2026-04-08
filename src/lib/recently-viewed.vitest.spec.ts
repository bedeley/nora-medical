// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { trackProductView, getRecentlyViewed } from "./recently-viewed";

const KEY = "nhs_recently_viewed";

beforeEach(() => {
  localStorage.clear();
});

describe("getRecentlyViewed", () => {
  it("returns empty array when nothing stored", () => {
    expect(getRecentlyViewed()).toEqual([]);
  });

  it("returns stored IDs in order", () => {
    localStorage.setItem(KEY, JSON.stringify(["id1", "id2", "id3"]));
    expect(getRecentlyViewed()).toEqual(["id1", "id2", "id3"]);
  });

  it("returns empty array on malformed JSON", () => {
    localStorage.setItem(KEY, "not-json{{{");
    expect(getRecentlyViewed()).toEqual([]);
  });
});

describe("trackProductView", () => {
  it("stores a viewed product ID", () => {
    trackProductView("prod-1");
    expect(getRecentlyViewed()).toEqual(["prod-1"]);
  });

  it("prepends new views to the front", () => {
    trackProductView("prod-1");
    trackProductView("prod-2");
    expect(getRecentlyViewed()).toEqual(["prod-2", "prod-1"]);
  });

  it("de-duplicates: re-viewing moves item to front", () => {
    trackProductView("prod-1");
    trackProductView("prod-2");
    trackProductView("prod-3");
    trackProductView("prod-1"); // revisit
    expect(getRecentlyViewed()).toEqual(["prod-1", "prod-3", "prod-2"]);
  });

  it("caps storage at 10 items", () => {
    for (let i = 1; i <= 12; i++) {
      trackProductView(`prod-${i}`);
    }
    const stored = getRecentlyViewed();
    expect(stored).toHaveLength(10);
    // Most recently viewed should be first
    expect(stored[0]).toBe("prod-12");
    // Oldest (prod-1, prod-2) should have been evicted
    expect(stored).not.toContain("prod-1");
    expect(stored).not.toContain("prod-2");
  });

  it("persists across multiple calls", () => {
    trackProductView("a");
    trackProductView("b");
    trackProductView("a"); // move a back to front
    expect(getRecentlyViewed()).toEqual(["a", "b"]);
  });
});
