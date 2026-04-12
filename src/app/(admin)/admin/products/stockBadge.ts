"use client";

import { chipToneBorderClass, chipToneClass, stockStatusTone } from "@/lib/status-chips";

export function getProductStockBadge(stock: number) {
  if (stock <= 0) {
    return {
      label: "Out",
      className: `${chipToneClass(stockStatusTone(stock, 5))} ${chipToneBorderClass("danger")}`,
    };
  }

  if (stock <= 5) {
    return {
      label: "Low",
      className: `${chipToneClass(stockStatusTone(stock, 5))} ${chipToneBorderClass("warning")}`,
    };
  }

  return null;
}
