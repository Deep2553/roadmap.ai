import { test, expect } from "@playwright/test";
import { runStamp } from "./fixtures";

test("landing page renders tracks", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /learning, mapped like a trail/i })).toBeVisible();
});

test("learner can sign up and reach dashboard", async ({ page }) => {
  const email = `learner-${runStamp()}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Name").fill("Test Learner");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});

test("public track page is read-only for signed-out visitors", async ({ page }) => {
  await page.goto("/tracks/devops");

  // `exact` matters: seeded milestone titles also contain "DevOps"
  // ("Python for DevOps", "Agentic AI for DevOps"), so a substring match on the
  // track heading is ambiguous.
  await expect(page.getByRole("heading", { level: 1, name: "DevOps", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /create an account/i })).toBeVisible();

  // Read-only: no completion toggles and no progress bar for anonymous visitors.
  await expect(page.getByRole("button", { name: /^Mark (complete|incomplete)$/ })).toHaveCount(0);
  await expect(page.getByRole("progressbar")).toHaveCount(0);

  // The seeded curriculum still renders milestones on the public page — this is
  // what the Jenkins pipeline's post-deploy smoke check depends on.
  const milestones = page.getByRole("heading", { level: 3 });
  expect(await milestones.count()).toBeGreaterThan(0);
});
