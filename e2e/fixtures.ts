/**
 * Shared test-account constants for the e2e suite.
 *
 * The learner is created by `e2e/global-setup.ts` (not by `lib/db/seed.ts`, so
 * no test account ever lands in a real deployment's seed). The admin matches
 * the seed defaults, overridable with the same env vars the seed reads.
 */
export const LEARNER_EMAIL = process.env.E2E_LEARNER_EMAIL ?? "e2e-learner@example.com";
export const LEARNER_PASSWORD = process.env.E2E_LEARNER_PASSWORD ?? "e2e-learner-pass";

export const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@roadmap.ai";
export const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";

/** Unique-per-run suffix, so repeated runs against one DB don't collide. */
export function runStamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
