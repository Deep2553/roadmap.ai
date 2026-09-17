import { hash } from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "../lib/db/client";
import { progress, users } from "../lib/db/schema";
import { LEARNER_EMAIL, LEARNER_PASSWORD } from "./fixtures";

/**
 * Ensures the e2e learner account exists before the suite runs.
 *
 * Logging in (rather than signing up) for the progress flow keeps the suite
 * re-runnable: `signupLearner` is rate-limited to 5 signups per IP per hour
 * (lib/rate-limit.ts, in-memory per server process), so a suite that signed up
 * in several tests would start failing after a couple of runs against the same
 * long-lived dev server.
 *
 * Idempotent, and writes to whatever `SQLITE_PATH` points at — run
 * `npm run db:migrate && npm run db:seed` against that same path first.
 */
export default async function globalSetup() {
  try {
    const existing = await db.query.users.findFirst({ where: eq(users.email, LEARNER_EMAIL) });
    if (existing) {
      // Reset progress so the toggle flow starts from a known 0%, even if an
      // earlier run failed mid-test and left a topic checked off.
      await db.delete(progress).where(eq(progress.userId, existing.id));
      return;
    }

    await db.insert(users).values({
      name: "E2E Learner",
      email: LEARNER_EMAIL,
      passwordHash: await hash(LEARNER_PASSWORD, 10),
      role: "learner",
    });
  } catch (err) {
    throw new Error(
      `e2e global setup could not reach the database at SQLITE_PATH=${process.env.SQLITE_PATH ?? "sqlite.db"}. ` +
        `Run "npm run db:migrate && npm run db:seed" against that path first. Cause: ${(err as Error).message}`,
    );
  }
}
