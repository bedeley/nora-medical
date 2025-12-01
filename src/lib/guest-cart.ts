export type GuestCartItem = {
  productId: string;
  quantity: number;
  updatedAt: string;
};

const STORAGE_KEY = "guest_cart_v1";

function safeNowISO(): string {
  try {
    return new Date().toISOString();
  } catch {
    return "";
  }
}

export function getGuestCart(): GuestCartItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((it) => {
        if (!it || typeof it !== "object") return null;
        const productId = String((it as { productId?: unknown }).productId || "");
        const quantityRaw = (it as { quantity?: unknown }).quantity;
        const quantity = Number(quantityRaw);
        if (!productId || !Number.isFinite(quantity) || quantity <= 0) return null;
        const updatedAt =
          typeof (it as { updatedAt?: unknown }).updatedAt === "string"
            ? String((it as { updatedAt?: unknown }).updatedAt)
            : safeNowISO();
        return { productId, quantity, updatedAt };
      })
      .filter((it): it is GuestCartItem => Boolean(it));
  } catch {
    return [];
  }
}

function setGuestCart(items: GuestCartItem[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ignore storage failures
  }
}

export function addToGuestCart(productId: string, quantity = 1): void {
  if (!productId || quantity <= 0) return;
  const items = getGuestCart();
  const idx = items.findIndex((it) => it.productId === productId);
  if (idx >= 0) {
    const nextQty = items[idx].quantity + quantity;
    items[idx] = {
      ...items[idx],
      quantity: nextQty,
      updatedAt: safeNowISO(),
    };
  } else {
    items.push({ productId, quantity, updatedAt: safeNowISO() });
  }
  setGuestCart(items);
}

export function updateGuestCartItem(productId: string, quantity: number): void {
  if (!productId) return;
  const items = getGuestCart();
  const idx = items.findIndex((it) => it.productId === productId);
  if (idx < 0) return;
  if (!Number.isFinite(quantity) || quantity <= 0) {
    items.splice(idx, 1);
  } else {
    items[idx] = { ...items[idx], quantity, updatedAt: safeNowISO() };
  }
  setGuestCart(items);
}

export function removeGuestCartItem(productId: string): void {
  if (!productId) return;
  const items = getGuestCart().filter((it) => it.productId !== productId);
  setGuestCart(items);
}

export function clearGuestCart(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

