import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

function buildUsersPayload() {
  const now = Date.now();
  const daysAgo = (days) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

  return {
    rows: [
      {
        user: {
          id: "user-admin",
          name: "Ama Admin",
          email: "ama.admin@example.com",
          phone: "0240000001",
          role: "ADMIN",
          archived: false,
          isProtected: true,
          lastLoginAt: daysAgo(70),
          createdAt: daysAgo(420),
          employeeId: "emp-admin",
          lastRoleChange: {
            at: daysAgo(55),
            by: { id: "actor-1", name: "Nora Admin", email: "nora@example.com" },
            from: "ACCOUNTANT",
            to: "ADMIN",
          },
        },
      },
      {
        user: {
          id: "user-missing-hr",
          name: "Akosua Missing",
          email: "akosua@example.com",
          phone: "0240000002",
          role: "STAFF",
          archived: false,
          isProtected: false,
          lastLoginAt: daysAgo(2),
          createdAt: daysAgo(180),
          employeeId: null,
          lastRoleChange: null,
        },
      },
      {
        user: {
          id: "user-invite",
          name: "Yaw Invite",
          email: "yaw@example.com",
          phone: "0240000003",
          role: "STAFF",
          archived: false,
          isProtected: false,
          lastLoginAt: null,
          createdAt: daysAgo(5),
          employeeId: "emp-invite",
          lastRoleChange: null,
        },
      },
      {
        user: {
          id: "user-accountant",
          name: "Kojo Accounts",
          email: "kojo@example.com",
          phone: "0240000004",
          role: "ACCOUNTANT",
          archived: false,
          isProtected: false,
          lastLoginAt: daysAgo(45),
          createdAt: daysAgo(300),
          employeeId: "emp-accountant",
          lastRoleChange: null,
        },
      },
    ],
  };
}

function buildInvitePayload() {
  const now = Date.now();
  return {
    rows: [
      {
        id: "invite-1",
        userId: "user-invite",
        createdAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
        expiresAt: new Date(now + 6 * 60 * 60 * 1000).toISOString(),
        user: {
          id: "user-invite",
          name: "Yaw Invite",
          email: "yaw@example.com",
          phone: "0240000003",
          role: "STAFF",
        },
      },
    ],
  };
}

test.describe("Admin users page", () => {
  test.beforeEach(async ({ page }) => {
    const usersPayload = buildUsersPayload();
    const invitePayload = buildInvitePayload();

    await page.route("**/api/admin/users?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(usersPayload),
      });
    });

    await page.route("**/api/admin/users/invite", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(invitePayload),
      });
    });
  });

  test("shows hero, quick filters, and invite urgency", async ({ page }) => {
    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: "Users & Roles" })).toBeVisible();
    await expect(page.getByText("People access", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Invite user account/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /Start HR onboarding/i })).toHaveAttribute(
      "href",
      "/admin/hr/onboarding?source=users",
    );
    await expect(page.getByRole("button", { name: /Missing HR profile \(1\)/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Pending invite \(1\)/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Protected admin \(1\)/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Dormant elevated access \(2\)/ })).toBeVisible();

    await page.getByRole("button", { name: /Missing HR profile \(1\)/ }).click();
    await expect(page.locator("#directory tbody tr")).toHaveCount(1);
    await expect(page.locator("#directory")).toContainText("Akosua Missing");

    await page.getByRole("button", { name: /Pending invite \(1\)/ }).click();
    await expect(page.locator("#directory tbody tr")).toHaveCount(1);
    await expect(page.locator("#directory")).toContainText("Yaw Invite");

    await expect(page.locator("#pending-invites")).toContainText("Expires soon");
    await expect(page.locator("#pending-invites")).toContainText("Yaw Invite");
  });

  test("renders stacked mobile cards for the directory", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/admin/users");

    await expect(page.locator("#directory").getByText("Last seen:").first()).toBeVisible();
    await expect(page.locator("#directory")).toContainText("Dormant elevated access");

    await page.getByRole("button", { name: /Dormant elevated access \(2\)/ }).click();
    await expect(page.locator("#directory .rounded-2xl").filter({ hasText: "Ama Admin" }).first()).toBeVisible();
    await expect(page.locator("#directory .rounded-2xl").filter({ hasText: "Kojo Accounts" }).first()).toBeVisible();
  });
});
