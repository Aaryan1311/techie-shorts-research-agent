import "dotenv/config";
import cron from "node-cron";
import prisma from "./db";
import { PIPELINE_CRON } from "./config";
import { runSetupStage } from "./stages/0-setup";
import { runFetchStage } from "./stages/1-fetch";
import { runClassifyStage } from "./stages/2-classify";
import { runDeduplicateStage } from "./stages/4-deduplicate";
import { runGenerateStage } from "./stages/6-generate";
import { runPublishStage } from "./stages/8-publish";

async function unstickClassifiedArticles(): Promise<void> {
  // Move articles stuck at CLASSIFIED for 30+ minutes to DEDUPED
  // (legacy articles from before dedup stage was added)
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
  const result = await prisma.pipelineArticle.updateMany({
    where: {
      stage: "CLASSIFIED",
      classifiedAt: { lt: thirtyMinAgo },
    },
    data: {
      stage: "DEDUPED",
      isDuplicate: false,
      deduplicationReason: "Auto-promoted: stuck at CLASSIFIED for 30+ minutes",
      deduplicatedAt: new Date(),
    },
  });

  if (result.count > 0) {
    console.log(`[Pipeline] Auto-promoted ${result.count} stuck CLASSIFIED articles to DEDUPED`);
  }
}

async function runPipeline(): Promise<void> {
  const start = new Date();
  console.log(`\n🚀 Pipeline run starting at ${start.toISOString()}`);
  console.log("═".repeat(60));

  let fetched = 0;
  let classified = { passed: 0, rejected: 0 };
  let deduped = { unique: 0, duplicates: 0, updates: 0 };
  let generated = 0;
  let published = 0;

  // Stage 0: Setup (tags, enum values)
  try {
    await runSetupStage();
  } catch (err: any) {
    console.error("[Pipeline] Stage 0 (Setup) failed:", err.message);
  }

  // Unstick legacy CLASSIFIED articles
  try {
    await unstickClassifiedArticles();
  } catch (err: any) {
    console.error("[Pipeline] Unstick failed:", err.message);
  }

  // Stage 1: Fetch
  try {
    fetched = await runFetchStage();
  } catch (err: any) {
    console.error("[Pipeline] Stage 1 (Fetch) failed:", err.message);
  }

  // Stage 2: Classify
  try {
    classified = await runClassifyStage();
  } catch (err: any) {
    console.error("[Pipeline] Stage 2 (Classify) failed:", err.message);
  }

  // Stage 4: Deduplicate
  try {
    deduped = await runDeduplicateStage();
  } catch (err: any) {
    console.error("[Pipeline] Stage 4 (Deduplicate) failed:", err.message);
  }

  // Stage 6: Generate
  try {
    generated = await runGenerateStage();
  } catch (err: any) {
    console.error("[Pipeline] Stage 6 (Generate) failed:", err.message);
  }

  // Stage 8: Publish
  try {
    published = await runPublishStage();
  } catch (err: any) {
    console.error("[Pipeline] Stage 8 (Publish) failed:", err.message);
  }

  const elapsed = ((Date.now() - start.getTime()) / 1000).toFixed(1);
  console.log("═".repeat(60));
  console.log(
    `✅ Pipeline complete in ${elapsed}s: ` +
      `${fetched} fetched, ${classified.passed} classified (${classified.rejected} rejected), ` +
      `${deduped.unique} unique (${deduped.duplicates} dupes), ` +
      `${generated} generated, ${published} published`
  );
}

async function main(): Promise<void> {
  console.log("Techie Shorts Research Agent starting...");
  console.log(`Cron schedule: ${PIPELINE_CRON}`);

  // Run immediately on startup
  await runPipeline();

  // Schedule recurring runs
  cron.schedule(PIPELINE_CRON, async () => {
    try {
      await runPipeline();
    } catch (err: any) {
      console.error("[cron] Pipeline run failed:", err.message);
    }
  });

  console.log("\nAgent running. Waiting for next scheduled run...");
}

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received. Shutting down...`);
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch(async (err) => {
  console.error("Fatal error:", err);
  await prisma.$disconnect();
  process.exit(1);
});
