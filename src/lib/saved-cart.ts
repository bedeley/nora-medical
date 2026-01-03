export type SavedCartItem = {
  productId: string;
  quantity: number;
  updatedAt?: string;
};

const STORAGE_KEY = "saved-cart";

export function getSavedCart(): SavedCartItem[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedCartItem[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

export function setSavedCart(items: SavedCartItem[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {}
}

export function addSavedCartItem(productId: string, quantity: number) {
  const items = getSavedCart();
  const existing = items.find((it) => it.productId === productId);
  if (existing) {
    existing.quantity = quantity;
    existing.updatedAt = new Date().toISOString();
    setSavedCart([...items]);
    return;
  }
  items.push({ productId, quantity, updatedAt: new Date().toISOString() });
  setSavedCart(items);
}

export function removeSavedCartItem(productId: string) {
  const items = getSavedCart().filter((it) => it.productId !== productId);
  setSavedCart(items);
}
