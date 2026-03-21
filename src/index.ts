import "dotenv/config";
import cron from "node-cron";
import prisma from "./db";
import { PIPELINE_CRON } from "./config";
import { runFetchStage } from "./stages/1-fetch";
import { runClassifyStage } from "./stages/2-classify";
import { runGenerateStage } from "./stages/6-generate";
import { runPublishStage } from "./stages/8-publish";

async function runPipeline(): Promise<void> {
  const start = new Date();
  console.log(`\n🚀 Pipeline run starting at ${start.toISOString()}`);
  console.log("═".repeat(60));

  let fetched = 0;
  let classified = { passed: 0, rejected: 0 };
  let generated = 0;
  let published = 0;

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

  // Stage 6: Generate (skipping 3-5 for Phase 1)
  try {
    generated = await runGenerateStage();
  } catch (err: any) {
    console.error("[Pipeline] Stage 6 (Generate) failed:", err.message);
  }

  // Stage 8: Publish (skipping 7 for Phase 1)
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
