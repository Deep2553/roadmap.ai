import "dotenv/config";
import { hash } from "bcryptjs";
import { db } from "./client";
import { users, subjects, topics, resources } from "./schema";

type CareerLevel = "fresher" | "intermediate" | "expert";

function twsResourcesFor(topicTitle: string) {
  return [
    {
      title: `${topicTitle} on TrainWithShubham (YouTube)`,
      url: `https://www.youtube.com/@TrainWithShubham/search?query=${encodeURIComponent(topicTitle)}`,
      type: "video" as const,
    },
    {
      title: "TrainWithShubham.com",
      url: "https://www.trainwithshubham.com",
      type: "doc" as const,
    },
  ];
}

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@roadmap.ai";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";

  // Idempotent: seeding an already-seeded database used to fail with a bare
  // "UNIQUE constraint failed: users.email" from the admin insert below. Exit
  // early instead, so an automated deploy can run this unconditionally and a
  // second local `npm run db:seed` is a no-op rather than a confusing crash.
  // `db.query.*` rather than `db.select().from()`: `db` is a union of the
  // better-sqlite3 and libsql drivers (lib/db/client.ts), and the query-builder
  // chain does not typecheck across that union.
  const existing = await db.query.users.findFirst({ columns: { id: true } });
  if (existing) {
    console.log("Database already has users — seed skipped.");
    return;
  }

  const [admin] = await db
    .insert(users)
    .values({
      name: "Admin",
      email: adminEmail,
      passwordHash: await hash(adminPassword, 10),
      role: "admin",
    })
    .returning();

  const [devops] = await db
    .insert(subjects)
    .values({
      slug: "devops",
      title: "DevOps",
      description: "From Linux fundamentals to Kubernetes and infrastructure automation.",
      color: "#f97316",
      order: 0,
      createdBy: admin.id,
    })
    .returning();

  const [cloud] = await db
    .insert(subjects)
    .values({
      slug: "cloud-engineering",
      title: "Cloud Engineering",
      description: "Core AWS services and cloud architecture patterns.",
      color: "#0ea5e9",
      order: 1,
      createdBy: admin.id,
    })
    .returning();

  // Curated from TrainWithShubham's "DevOps - Zero To Hero" curriculum planner
  // (internal reference sheet) — career levels informed by its "DevOps Job
  // Relevance %" column, one-time reference for this seed, not a live sync.
  const devopsMilestones: { title: string; description: string; careerLevel: CareerLevel }[] = [
    { title: "Python for DevOps", description: "Python fundamentals, APIs, file handling, and scripting for automation.", careerLevel: "fresher" },
    { title: "Introduction to DevOps & Cloud", description: "DevOps culture, career paths (DevOps/Cloud/SRE), and what to expect.", careerLevel: "fresher" },
    { title: "Linux", description: "Shell, filesystem, permissions, processes.", careerLevel: "fresher" },
    { title: "Networking", description: "TCP/IP, DNS, HTTP, load balancing basics.", careerLevel: "fresher" },
    { title: "Shell Scripting", description: "Bash fundamentals and automation scripts for cleanup, log rotation, and alerts.", careerLevel: "fresher" },
    { title: "Git", description: "Version control workflows and collaboration.", careerLevel: "fresher" },
    { title: "Docker", description: "Containers, images, Dockerfiles, Compose.", careerLevel: "intermediate" },
    { title: "Jenkins", description: "CI/CD pipelines and automation.", careerLevel: "intermediate" },
    { title: "GitHub Actions", description: "CI pipelines with SAST, OIDC to AWS, matrix builds, and self-hosted runners.", careerLevel: "intermediate" },
    { title: "DevSecOps", description: "SonarQube, Trivy, OWASP, and Docker Scout for secure CI/CD.", careerLevel: "intermediate" },
    { title: "Kubernetes", description: "Container orchestration at scale.", careerLevel: "expert" },
    { title: "Terraform", description: "Infrastructure as code.", careerLevel: "expert" },
    { title: "Ansible", description: "Architecture, inventories, ad-hoc commands, playbooks, and roles.", careerLevel: "expert" },
    { title: "Monitoring (Grafana & Prometheus)", description: "Observability, alerting, and visualization.", careerLevel: "expert" },
    { title: "Agentic AI for DevOps", description: "Gen AI, agentic frameworks, MCP integration, and a DevOps Copilot agent that reads logs and suggests fixes.", careerLevel: "expert" },
    { title: "Job Assistance", description: "LinkedIn and resume optimization, plus mock interview practice.", careerLevel: "fresher" },
  ];

  for (const [i, m] of devopsMilestones.entries()) {
    const [topic] = await db
      .insert(topics)
      .values({
        subjectId: devops.id,
        title: m.title,
        description: m.description,
        level: "milestone",
        careerLevel: m.careerLevel,
        order: i,
      })
      .returning();

    for (const [j, r] of twsResourcesFor(m.title).entries()) {
      await db.insert(resources).values({ topicId: topic.id, order: j, ...r });
    }
  }

  const cloudMilestones: { title: string; description: string; careerLevel: CareerLevel }[] = [
    { title: "AWS Fundamentals", description: "IAM, regions, and the shared responsibility model.", careerLevel: "fresher" },
    { title: "EC2", description: "Virtual machines, AMIs, auto scaling.", careerLevel: "fresher" },
    { title: "RDS", description: "Managed relational databases.", careerLevel: "intermediate" },
    { title: "S3", description: "Object storage and static hosting.", careerLevel: "intermediate" },
    { title: "VPC", description: "Networking, subnets, security groups.", careerLevel: "expert" },
  ];

  for (const [i, m] of cloudMilestones.entries()) {
    await db.insert(topics).values({
      subjectId: cloud.id,
      title: m.title,
      description: m.description,
      level: "milestone",
      careerLevel: m.careerLevel,
      order: i,
    });
  }

  // Never log the password: this output ends up in CI consoles and shared
  // terminals. The value is SEED_ADMIN_PASSWORD, or the default documented
  // in README.md.
  console.log("Seeded database. Admin email:", adminEmail);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
