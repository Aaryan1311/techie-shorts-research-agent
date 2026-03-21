import prisma from "../db";

const NEW_TAGS = [
  { name: "Competitive Programming", slug: "competitive-programming", color: "#8B5CF6" },
  { name: "Gaming & Gadgets", slug: "gaming-gadgets", color: "#EC4899" },
  { name: "Design & UX", slug: "design-ux", color: "#F472B6" },
  { name: "QA & Testing", slug: "qa-testing", color: "#14B8A6" },
  { name: "Research & Papers", slug: "research-papers", color: "#6366F1" },
  { name: "Cool Tech", slug: "cool-tech", color: "#F59E0B" },
  { name: "Tech Personalities", slug: "tech-personalities", color: "#EF4444" },
  { name: "Startups & Funding", slug: "startups-funding", color: "#10B981" },
  { name: "Indian Tech", slug: "indian-tech", color: "#FF6B35" },
  { name: "Trending", slug: "trending", color: "#EF4444" },
];

const NEW_ARTICLE_TYPES = [
  "COMPETITIVE_PROGRAMMING",
  "GAMING_GADGETS",
  "DESIGN",
  "RESEARCH",
  "COOL_TECH",
  "CAREER_CULTURE",
];

const PIPELINE_STAGE_VALUES = [
  "SOURCE_READ",
  "VERIFIED",
  "QA_PASSED",
];

export async function runSetupStage(): Promise<void> {
  console.log("[Stage 0] Running setup...");

  // Ensure new tags exist
  for (const tag of NEW_TAGS) {
    try {
      await prisma.$executeRaw`
        INSERT INTO tags (id, name, slug, color, "createdAt")
        VALUES (gen_random_uuid()::text, ${tag.name}, ${tag.slug}, ${tag.color}, NOW())
        ON CONFLICT (slug) DO NOTHING
      `;
    } catch (err: any) {
      console.warn(`[setup] Tag insert failed for ${tag.slug}: ${err.message}`);
    }
  }

  // Ensure new ArticleType enum values exist
  // Must use $executeRawUnsafe because ALTER TYPE ... ADD VALUE doesn't support parameterized values
  for (const value of NEW_ARTICLE_TYPES) {
    try {
      await prisma.$executeRawUnsafe(
        `ALTER TYPE "ArticleType" ADD VALUE IF NOT EXISTS '${value}'`
      );
      console.log(`[setup] Enum value '${value}': OK`);
    } catch (err: any) {
      if (err.message?.includes("already exists")) {
        console.log(`[setup] Enum value '${value}': already exists`);
      } else {
        console.error(`[setup] FAILED to add enum value '${value}': ${err.message}`);
        console.error(`[setup] Full error:`, err);
      }
    }
  }

  // Ensure PipelineStage enum values exist
  for (const value of PIPELINE_STAGE_VALUES) {
    try {
      await prisma.$executeRawUnsafe(
        `ALTER TYPE "PipelineStage" ADD VALUE IF NOT EXISTS '${value}'`
      );
    } catch (err: any) {
      if (!err.message?.includes("already exists")) {
        console.warn(`[setup] PipelineStage enum add failed for ${value}: ${err.message}`);
      }
    }
  }

  console.log("[Stage 0] Setup complete");
}
