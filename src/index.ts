import "dotenv/config";
import cron from "node-cron";
import prisma from "./db";
import { PIPELINE_CRON, DAILY_LIMITS } from "./config";
import { runSetupStage } from "./stages/0-setup";
import { runFetchStage, FetchResult } from "./stages/1-fetch";
import { runClassifyStage } from "./stages/2-classify";
import { runReadSourceStage } from "./stages/3-read-source";
import { runDeduplicateStage } from "./stages/4-deduplicate";
import { runVerifyStage } from "./stages/5-verify";
import { runGenerateStage, regenerateIncomplete } from "./stages/6-generate";
import { runQAReviewStage } from "./stages/7-qa-review";
import { runPublishStage } from "./stages/8-publish";
import { getLLMCounts } from "./models/model-router";
import { setRateLimited } from "./models/groq";

const STUCK_PROMOTIONS: { from: string; to: string; field: string }[] = [
  { from: "CLASSIFIED", to: "SOURCE_READ", field: "classifiedAt" },
  { from: "SOURCE_READ", to: "DEDUPED", field: "sourceReadAt" },
  { from: "DEDUPED", to: "VERIFIED", field: "deduplicatedAt" },
  { from: "VERIFIED", to: "CONTENT_GENERATED", field: "verifiedAt" },
  { from: "CONTENT_GENERATED", to: "QA_PASSED", field: "generatedAt" },
];

async function unstickArticles(): Promise<void> {
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);

  for (const promo of STUCK_PROMOTIONS) {
    try {
      const result = await prisma.pipelineArticle.updateMany({
        where: {
          stage: promo.from as any,
          [promo.field]: { lt: thirtyMinAgo },
        },
        data: {
          stage: promo.to as any,
        },
      });

      if (result.count > 0) {
        console.log(`[Pipeline] Auto-promoted ${result.count} stuck ${promo.from} → ${promo.to}`);
      }
    } catch {
      // Non-critical
    }
  }
}

function checkBudget(stage: string): boolean {
  const counts = getLLMCounts();

  if (counts.total >= DAILY_LIMITS.maxTotalLLMCalls) {
    console.warn(`[Pipeline] Daily LLM budget reached (${counts.total}/${DAILY_LIMITS.maxTotalLLMCalls}) — skipping ${stage}`);
    return false;
  }

  if (stage === "classify" && counts.classify >= DAILY_LIMITS.maxClassifyPerDay) {
    console.warn(`[Pipeline] Daily classify budget reached (${counts.classify}/${DAILY_LIMITS.maxClassifyPerDay}) — skipping`);
    return false;
  }

  if (stage === "generate" && counts.generate >= DAILY_LIMITS.maxGeneratePerDay) {
    console.warn(`[Pipeline] Daily generate budget reached (${counts.generate}/${DAILY_LIMITS.maxGeneratePerDay}) — skipping`);
    return false;
  }

  return true;
}

async function runPipeline(): Promise<void> {
  const start = new Date();
  console.log(`\n🚀 Pipeline run starting at ${start.toISOString()}`);
  console.log("═".repeat(60));

  // Reset rate-limit flag at start of each run
  setRateLimited(false);

  let fetchResult: FetchResult = { newCount: 0, sourceCounts: {} };
  let classified = { passed: 0, rejected: 0 };
  let sourceRead = { success: 0, failed: 0 };
  let deduped = { unique: 0, duplicates: 0, updates: 0 };
  let verified = { passed: 0, failed: 0 };
  let generated = 0;
  let qaResult = { published: 0, revised: 0, rejected: 0 };
  let published = 0;
  let errors = 0;

  // Stage 0: Setup
  try {
    await runSetupStage();
  } catch (err: any) {
    console.error("[Pipeline] Stage 0 (Setup) failed:", err.message);
    errors++;
  }

  // Unstick articles at any stage
  try {
    await unstickArticles();
  } catch (err: any) {
    console.error("[Pipeline] Unstick failed:", err.message);
    errors++;
  }

  // Stage 1: Fetch
  try {
    fetchResult = await runFetchStage();
  } catch (err: any) {
    console.error("[Pipeline] Stage 1 (Fetch) failed:", err.message);
    errors++;
  }

  // Skip remaining stages if no new articles
  if (fetchResult.newCount === 0) {
    const elapsed = ((Date.now() - start.getTime()) / 1000).toFixed(1);
    console.log("═".repeat(60));
    console.log(`⏭️  No new articles — skipping pipeline (${elapsed}s)`);
    return;
  }

  // Stage 2: Classify
  if (checkBudget("classify")) {
    try {
      classified = await runClassifyStage();
    } catch (err: any) {
      console.error("[Pipeline] Stage 2 (Classify) failed:", err.message);
      errors++;
    }
  }

  // Stage 3: Read Source (no LLM calls)
  try {
    sourceRead = await runReadSourceStage();
  } catch (err: any) {
    console.error("[Pipeline] Stage 3 (Read Source) failed:", err.message);
    errors++;
  }

  // Stage 4: Deduplicate
  if (checkBudget("classify")) {
    try {
      deduped = await runDeduplicateStage();
    } catch (err: any) {
      console.error("[Pipeline] Stage 4 (Deduplicate) failed:", err.message);
      errors++;
    }
  }

  // Stage 5: Verify
  if (checkBudget("classify")) {
    try {
      verified = await runVerifyStage();
    } catch (err: any) {
      console.error("[Pipeline] Stage 5 (Verify) failed:", err.message);
      errors++;
    }
  }

  // Stage 6: Generate
  if (checkBudget("generate")) {
    try {
      generated = await runGenerateStage();
    } catch (err: any) {
      console.error("[Pipeline] Stage 6 (Generate) failed:", err.message);
      errors++;
    }
  }

  // Stage 7: QA Review
  if (checkBudget("classify")) {
    try {
      qaResult = await runQAReviewStage();
    } catch (err: any) {
      console.error("[Pipeline] Stage 7 (QA Review) failed:", err.message);
      errors++;
    }
  }

  // Stage 8: Publish (no LLM calls)
  try {
    published = await runPublishStage();
  } catch (err: any) {
    console.error("[Pipeline] Stage 8 (Publish) failed:", err.message);
    errors++;
  }

  // Regenerate incomplete articles from previous runs
  let regenerated = 0;
  if (checkBudget("generate")) {
    try {
      regenerated = await regenerateIncomplete();
    } catch (err: any) {
      console.error("[Pipeline] Regenerate incomplete failed:", err.message);
      errors++;
    }
  }

  // Count failed articles
  let failed = 0;
  try {
    failed = await prisma.pipelineArticle.count({
      where: {
        stage: "FAILED",
        failedAt: { gte: start },
      },
    });
  } catch {
    // Non-critical
  }

  // Detailed summary
  const counts = getLLMCounts();
  const elapsed = ((Date.now() - start.getTime()) / 1000).toFixed(1);
  console.log("═".repeat(60));
  console.log(`✅ Pipeline complete in ${elapsed}s`);
  console.log(`   Fetched: ${fetchResult.newCount} new items`);

  if (Object.keys(fetchResult.sourceCounts).length > 0) {
    const sourceStr = Object.entries(fetchResult.sourceCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([s, c]) => `${s}(${c})`)
      .join(", ");
    console.log(`   Sources: ${sourceStr}`);
  }

  console.log(`   Classified: ${classified.passed} passed, ${classified.rejected} rejected`);
  console.log(`   Source Read: ${sourceRead.success} ok, ${sourceRead.failed} failed`);
  console.log(`   Deduped: ${deduped.unique} unique, ${deduped.duplicates} duplicates`);
  console.log(`   Verified: ${verified.passed} passed, ${verified.failed} rejected`);
  console.log(`   Generated: ${generated} articles`);
  console.log(`   QA Review: ${qaResult.published} passed, ${qaResult.revised} revised, ${qaResult.rejected} rejected`);
  console.log(`   Published: ${published} articles`);
  if (regenerated > 0) console.log(`   Regenerated: ${regenerated} incomplete articles`);
  console.log(`   Failed: ${failed}`);
  console.log(`   Errors: ${errors}`);
  console.log(`   LLM calls today: ${counts.total}/${DAILY_LIMITS.maxTotalLLMCalls} (classify: ${counts.classify}, generate: ${counts.generate})`);
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
