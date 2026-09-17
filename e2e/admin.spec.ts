import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, runStamp } from "./fixtures";

test("admin can create a subject and a milestone that show up on the public track page", async ({
  page,
  browser,
}) => {
  const stamp = runStamp();
  const subjectTitle = `E2E Track ${stamp}`;
  const slug = subjectTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-"); // mirrors lib/slug.ts
  const milestoneTitle = `E2E Milestone ${stamp}`;

  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in as admin/i }).click();
  await expect(page).toHaveURL(/\/admin$/);

  // Create the subject — createSubject redirects to its manage page.
  await page.getByLabel("Subject title").fill(subjectTitle);
  await page.getByLabel("Description").fill("Created by the e2e suite.");
  await page.getByRole("button", { name: /create subject/i }).click();
  await expect(page).toHaveURL(/\/admin\/subjects\/[^/]+$/);
  await expect(page.getByRole("heading", { level: 1, name: subjectTitle })).toBeVisible();

  // Add a top-level milestone (the Level select already defaults to "milestone").
  await page.getByLabel("Title").fill(milestoneTitle);
  await page.getByLabel("Description").fill("Milestone added by the e2e suite.");
  await page.getByRole("button", { name: /add topic/i }).click();
  await expect(page.getByText(milestoneTitle)).toBeVisible();

  // It is published on the public, signed-out track page.
  const publicContext = await browser.newContext();
  const publicPage = await publicContext.newPage();
  try {
    await publicPage.goto(`/tracks/${slug}`);
    await expect(
      publicPage.getByRole("heading", { level: 1, name: subjectTitle }),
    ).toBeVisible();
    await expect(publicPage.getByRole("heading", { level: 3, name: milestoneTitle })).toBeVisible();
    await expect(publicPage.getByRole("button", { name: /^Mark (complete|incomplete)$/ })).toHaveCount(0);
  } finally {
    await publicContext.close();
  }
});
