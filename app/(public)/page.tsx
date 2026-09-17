import Link from "next/link";
import { SiteNav } from "@/components/site-nav";
import { listSubjects } from "@/lib/data";
import { ArrowRight, MapPin } from "lucide-react";

// Lists admin-managed subjects — always render fresh, never prerender at build time
// (build environments, e.g. CI, may have no database available at all).
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const subjects = await listSubjects();

  return (
    <div className="flex min-h-screen flex-col">
      <SiteNav />
      <main className="flex-1">
        <section className="mx-auto max-w-4xl px-6 pt-20 pb-16 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-medium text-accent">
            <MapPin className="size-3" /> Plot your route, not just a checklist
          </span>
          <h1 className="mt-6 font-heading text-5xl font-semibold tracking-tight sm:text-6xl">
            Learning Deep, mapped like a trail.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg text-muted-foreground">
            TWS Roadmaps turns DevOps, Cloud, and other technical journeys into a
            walkable roadmap — pick a track, follow the trail, and mark every
            milestone as you clear it.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link
              href="/signup"
              className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-semibold text-accent-foreground shadow-sm transition-transform hover:-translate-y-0.5"
            >
              Start your trail <ArrowRight className="size-4" />
            </Link>
            <Link
              href="#tracks"
              className="text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Browse tracks
            </Link>
          </div>
        </section>

        <section id="tracks" className="mx-auto max-w-5xl px-6 pb-24">
          <h2 className="font-heading text-2xl font-semibold">Choose a track</h2>
          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            {subjects.map((s) => (
              <Link
                key={s.id}
                href={`/tracks/${s.slug}`}
                className="group relative overflow-hidden rounded-3xl border border-border bg-card p-6 transition-all hover:-translate-y-1 hover:shadow-lg"
              >
                <div
                  className="absolute -right-6 -top-6 size-24 rounded-full opacity-20 blur-xl transition-opacity group-hover:opacity-30"
                  style={{ background: s.color ?? "var(--accent)" }}
                />
                <h3 className="font-heading text-xl font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{s.description}</p>
                <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent">
                  View trail <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-1" />
                </span>
              </Link>
            ))}
            {subjects.length === 0 && (
              <p className="text-muted-foreground">No tracks yet — an admin needs to add one.</p>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
