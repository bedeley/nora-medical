// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ProductCard from "./ProductCard";

// ── Shared mock functions (hoisted so vi.mock factories can reference them) ─

const { mockPush, mockAddToGuestCart, mockTrackView } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockAddToGuestCart: vi.fn(),
  mockTrackView: vi.fn(),
}));

// ── External dependency mocks ──────────────────────────────────────────────

vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} />
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: null }),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: null }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/lib/guest-cart", () => ({
  addToGuestCart: mockAddToGuestCart,
  getGuestCart: () => [],
  removeGuestCartItem: vi.fn(),
  updateGuestCartItem: vi.fn(),
}));

vi.mock("@/lib/recently-viewed", () => ({
  trackProductView: mockTrackView,
}));

beforeEach(() => {
  mockPush.mockClear();
  mockAddToGuestCart.mockClear();
  mockTrackView.mockClear();
});

// ── Default props ──────────────────────────────────────────────────────────

const baseProps = {
  id: "prod-1",
  name: "Sterile Gloves",
  description: "Latex-free examination gloves",
  imageUrl: "/gloves.jpg",
  price: 25.5,
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ProductCard – rendering", () => {
  it("renders the product name", () => {
    render(<ProductCard {...baseProps} />);
    expect(screen.getByText("Sterile Gloves")).toBeInTheDocument();
  });

  it("renders the formatted price", () => {
    render(<ProductCard {...baseProps} price={25.5} />);
    // GHS currency format — just check the numeric part
    expect(screen.getByText(/25\.50/)).toBeInTheDocument();
  });

  it("renders the product image with correct alt text", () => {
    render(<ProductCard {...baseProps} />);
    const img = screen.getByRole("img", { name: "Sterile Gloves" });
    expect(img).toBeInTheDocument();
  });

  it("renders description text", () => {
    render(<ProductCard {...baseProps} />);
    expect(screen.getByText(/Latex-free examination gloves/i)).toBeInTheDocument();
  });

  it("renders category badge when category is provided", () => {
    render(<ProductCard {...baseProps} category="surgical" />);
    // Category label should appear somewhere
    expect(screen.getByText(/surgical/i)).toBeInTheDocument();
  });

  it("renders brand badge when brand is provided", () => {
    render(<ProductCard {...baseProps} brand="MedSupply Co" />);
    expect(screen.getByText("MedSupply Co")).toBeInTheDocument();
  });
});

describe("ProductCard – stock availability badges", () => {
  it("shows green 'In Stock' badge when inStock=true and not lowStock", () => {
    render(<ProductCard {...baseProps} inStock={true} lowStock={false} stock={50} />);
    expect(screen.getByText("In Stock")).toBeInTheDocument();
  });

  it("shows 'Only N left' when lowStock=true and stock count is provided", () => {
    render(<ProductCard {...baseProps} inStock={true} lowStock={true} stock={2} />);
    expect(screen.getByText("Only 2 left")).toBeInTheDocument();
  });

  it("shows generic 'Low Stock' when lowStock=true but no stock count", () => {
    render(<ProductCard {...baseProps} inStock={true} lowStock={true} />);
    expect(screen.getByText("Low Stock")).toBeInTheDocument();
  });

  it("shows 'Out of stock' text when inStock=false", () => {
    render(<ProductCard {...baseProps} inStock={false} />);
    expect(screen.getByText("Out of stock")).toBeInTheDocument();
  });

  it("does NOT show 'In Stock' badge when lowStock=true", () => {
    render(<ProductCard {...baseProps} inStock={true} lowStock={true} stock={3} />);
    expect(screen.queryByText("In Stock")).toBeNull();
  });

  it("does NOT show 'In Stock' badge when inStock=false", () => {
    render(<ProductCard {...baseProps} inStock={false} />);
    expect(screen.queryByText("In Stock")).toBeNull();
  });

  it("shows 'New' badge when isNew=true", () => {
    render(<ProductCard {...baseProps} isNew={true} />);
    expect(screen.getByText("New")).toBeInTheDocument();
  });

  it("does NOT show 'New' badge when isNew=false", () => {
    render(<ProductCard {...baseProps} isNew={false} />);
    expect(screen.queryByText("New")).toBeNull();
  });
});

describe("ProductCard – sale pricing", () => {
  it("shows sale price and strikethrough when compareAtPrice > price", () => {
    render(<ProductCard {...baseProps} price={18} compareAtPrice={25} />);
    // Discount badge should show
    expect(screen.getByText(/\d+% off/i)).toBeInTheDocument();
    // Both prices rendered
    expect(screen.getByText(/18\.00/)).toBeInTheDocument();
    expect(screen.getByText(/25\.00/)).toBeInTheDocument();
  });

  it("does NOT show discount badge when compareAtPrice <= price", () => {
    render(<ProductCard {...baseProps} price={25} compareAtPrice={20} />);
    expect(screen.queryByText(/% off/i)).toBeNull();
  });

  it("shows correct discount percentage", () => {
    // 50% off: price=10, compareAt=20
    render(<ProductCard {...baseProps} price={10} compareAtPrice={20} />);
    expect(screen.getByText("50% off")).toBeInTheDocument();
  });
});

describe("ProductCard – Add to Cart button", () => {
  it("renders an 'Add to Cart' button", () => {
    render(<ProductCard {...baseProps} inStock={true} />);
    expect(screen.getByRole("button", { name: /add to cart/i })).toBeInTheDocument();
  });

  it("button is disabled when out of stock", () => {
    render(<ProductCard {...baseProps} inStock={false} />);
    const btn = screen.getByRole("button", { name: /add to cart/i });
    expect(btn).toBeDisabled();
  });

  it("button is enabled when in stock", () => {
    render(<ProductCard {...baseProps} inStock={true} />);
    const btn = screen.getByRole("button", { name: /add to cart/i });
    expect(btn).not.toBeDisabled();
  });

  it("calls addToGuestCart when clicked (unauthenticated)", async () => {
    render(<ProductCard {...baseProps} inStock={true} />);
    fireEvent.click(screen.getByRole("button", { name: /add to cart/i }));
    // addToGuestCart is called for unauthenticated users
    await vi.waitFor(() => expect(mockAddToGuestCart).toHaveBeenCalledWith("prod-1", 1));
  });
});

describe("ProductCard – navigation", () => {
  it("tracks view and navigates to product detail on card click", () => {
    render(<ProductCard {...baseProps} />);
    // Click the card (the Card component wraps the text with an onClick handler)
    fireEvent.click(screen.getByText("Sterile Gloves"));
    expect(mockTrackView).toHaveBeenCalledWith("prod-1");
    expect(mockPush).toHaveBeenCalledWith("/products/prod-1");
  });
});
