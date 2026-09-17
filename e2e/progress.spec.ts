import { test, expect, type Page } from "@playwright/test";
import { LEARNER_EMAIL, LEARNER_PASSWORD } from "./fixtures";

async function loginAsLearner(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(LEARNER_EMAIL);
  await page.getByLabel("Password").fill(LEARNER_PASSWORD);
  await page.getByRole("button", { name: /^log in$/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

async function progressValue(page: Page) {
  return Number(await page.getByRole("progressbar").getAttribute("aria-valuenow"));
}

test("learner can toggle a topic complete and the progress persists across reload", async ({
  page,
}) => {
  await loginAsLearner(page);

  await page.goto("/tracks/devops");

  // Interactive view: progress bar plus per-milestone toggles.
  const progressbar = page.getByRole("progressbar");
  await expect(progressbar).toHaveAttribute("aria-valuenow", "0");
  const toComplete = page.getByRole("button", { name: "Mark complete" });
  const completed = page.getByRole("button", { name: "Mark incomplete" });
  const milestoneCount = await toComplete.count();
  expect(milestoneCount).toBeGreaterThan(0);

  await toComplete.first().click();

  // Progress bar reflects the toggle (server action + revalidatePath).
  await expect(completed).toHaveCount(1);
  await expect.poll(() => progressValue(page)).toBeGreaterThan(0);
  const afterToggle = await progressValue(page);

  // …and survives a full reload (i.e. it was written to the DB, not just local state).
  await page.reload();
  await expect(completed).toHaveCount(1);
  await expect(toComplete).toHaveCount(milestoneCount - 1);
  expect(await progressValue(page)).toBe(afterToggle);

  // The dashboard reads the same progress rows.
  await page.goto("/dashboard");
  const devopsCard = page.locator('a[href="/tracks/devops"]');
  await expect(devopsCard.getByText(/^\d+\/\d+$/)).toHaveText(/^1\/\d+$/);

  // Un-toggling persists too.
  await page.goto("/tracks/devops");
  await completed.first().click();
  await expect(completed).toHaveCount(0);
  await page.reload();
  await expect(progressbar).toHaveAttribute("aria-valuenow", "0");
  await expect(toComplete).toHaveCount(milestoneCount);
});
