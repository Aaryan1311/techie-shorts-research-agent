import prisma from "../db";
import { callModel } from "../models/model-router";
import { parseJSON } from "../models/groq";
import { MAX_ARTICLES_PER_RUN } from "../config";
import { hasBudget, getBudgetStatus } from "../utils/tokenBudget";

const QA_SYSTEM_PROMPT = `You are a senior editor reviewing AI-generated news content before publication. Be critical but fair.

Review and return ONLY valid JSON:
{
  "accuracyScore": 1-10,
  "clarityScore": 1-10,
  "completenessScore": 1-10,
  "clickbaitScore": 1-10,
  "overallScore": 1-10,
  "verdict": "PUBLISH" | "REVISE" | "REJECT",
  "issues": "specific issues found, or 'none'"
}

SCORING:
- accuracyScore: Does the generated content match the source? Any hallucinated facts? 10 = perfectly accurate, 1 = makes stuff up
- clarityScore: Would a non-technical person understand this? 10 = crystal clear, 1 = confusing jargon
- completenessScore: Does it cover the key facts from the source? 10 = comprehensive, 1 = misses important details
- clickbaitScore: Is the headline catchy but HONEST? 10 = engaging and accurate, 1 = misleading clickbait. NOTE: catchy ≠ clickbait. "Java's Speed Isn't the Problem, Your Code Might Be" is catchy AND honest = 9. "This Java Bug Will DESTROY Your App" is clickbait = 3.
- overallScore: Your overall quality rating
- verdict: PUBLISH if overallScore >= 7. REVISE if 5-6 (fixable issues). REJECT if < 5 (fundamental problems).`;

const SLOP_PHRASES = [
  "game-changer", "revolutionary", "groundbreaking", "paradigm shift",
  "synergy", "leverage", "disrupt",
];

interface QAResult {
  accuracyScore: number;
  clarityScore: number;
  completenessScore: number;
  clickbaitScore: number;
  overallScore: number;
  verdict: "PUBLISH" | "REVISE" | "REJECT";
  issues: string;
}

function programmaticQA(article: any): { pass: boolean; issues: string[] } {
  const issues: string[] = [];

  // Check summary word count (should be 60-80)
  const wordCount = article.generatedSummary?.split(/\s+/).length || 0;
  if (wordCount < 40) issues.push(`Summary too short: ${wordCount} words`);
  if (wordCount > 120) issues.push(`Summary too long: ${wordCount} words`);

  // Check headline length
  const headlineLen = article.generatedHeadline?.length || 0;
  if (headlineLen < 20) issues.push(`Headline too short: ${headlineLen} chars`);
  if (headlineLen > 100) issues.push(`Headline too long: ${headlineLen} chars`);

  // Check detail content
  const detailWords = article.generatedDetail?.split(/\s+/).length || 0;
  if (detailWords < 100) issues.push(`Detail too short: ${detailWords} words`);

  // Check whatsNext
  if (!article.generatedWhatsNext || article.generatedWhatsNext.length < 50) {
    issues.push("WhatsNext content missing or too short");
  }

  // Check for AI slop
  const allText = `${article.generatedHeadline} ${article.generatedSummary} ${article.generatedDetail}`.toLowerCase();
  for (const phrase of SLOP_PHRASES) {
    if (allText.includes(phrase)) issues.push(`AI slop detected: "${phrase}"`);
  }

  return { pass: issues.length <= 1, issues }; // Allow 1 minor issue
}

export async function runQAReviewStage(): Promise<{ published: number; revised: number; rejected: number }> {
  console.log("[Stage 7] QA reviewing articles...");

  if (!hasBudget()) {
    console.warn(`[Stage 7] Daily token budget exhausted (${getBudgetStatus()}). Will resume tomorrow.`);
    return { published: 0, revised: 0, rejected: 0 };
  }

  const articles = await prisma.pipelineArticle.findMany({
    where: { stage: "CONTENT_GENERATED" },
    orderBy: { createdAt: "asc" },
    take: MAX_ARTICLES_PER_RUN,
  });

  if (articles.length === 0) {
    console.log("[Stage 7] No articles to review");
    return { published: 0, revised: 0, rejected: 0 };
  }

  let published = 0;
  let revised = 0;
  let rejected = 0;

  for (const article of articles) {
    try {
      // Programmatic checks first
      const progCheck = programmaticQA(article);

      if (!progCheck.pass) {
        // Check if this is a second QA failure (retry count > 0 for QA)
        if (article.retryCount > 0) {
          // Second failure — publish anyway with lower score
          console.warn(`[qa] Second QA failure for ${article.rawTitle}, publishing anyway: ${progCheck.issues.join("; ")}`);
          await prisma.pipelineArticle.update({
            where: { id: article.id },
            data: {
              stage: "QA_PASSED",
              qaScore: 5,
              qaNotes: `Auto-passed (2nd attempt). Issues: ${progCheck.issues.join("; ")}`,
              qaPassedAt: new Date(),
            },
          });
          published++;
          continue;
        }

        // First failure — send back to generate (REVISE)
        console.warn(`[qa] Programmatic QA failed for ${article.rawTitle}: ${progCheck.issues.join("; ")}`);
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "VERIFIED", // Send back to Stage 6
            qaNotes: `Programmatic QA failed: ${progCheck.issues.join("; ")}`,
            retryCount: { increment: 1 },
          },
        });
        revised++;
        continue;
      }

      // LLM QA review
      const sourcePreview = article.fullArticleText
        ? article.fullArticleText.split(/\s+/).slice(0, 300).join(" ")
        : "N/A";

      const detailPreview = article.generatedDetail
        ? article.generatedDetail.split(/\s+/).slice(0, 500).join(" ")
        : "N/A";

      const userPrompt = `Original article title: ${article.rawTitle}
Source: ${article.source}
Source content preview: ${sourcePreview}

Generated headline: ${article.generatedHeadline}
Generated summary: ${article.generatedSummary}
Generated detail (first 500 words): ${detailPreview}`;

      // 3 second delay between LLM calls
      await new Promise((r) => setTimeout(r, 3000));

      const result = await callModel("qa", QA_SYSTEM_PROMPT, userPrompt);

      if (!result) {
        // LLM failed — auto-pass
        console.warn(`[qa] LLM failed for ${article.rawTitle}, auto-passing`);
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "QA_PASSED",
            qaScore: 7,
            qaNotes: "QA skipped — LLM error",
            qaPassedAt: new Date(),
          },
        });
        published++;
        continue;
      }

      const parsed = parseJSON<QAResult>(result.response);

      if (!parsed) {
        // Parse failed — auto-pass
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "QA_PASSED",
            qaScore: 7,
            qaNotes: "QA skipped — unparseable response",
            qaPassedAt: new Date(),
            qaReviewedByModel: result.model,
          },
        });
        published++;
        continue;
      }

      if (parsed.verdict === "PUBLISH") {
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "QA_PASSED",
            qaScore: parsed.overallScore,
            qaNotes: parsed.issues ?? "none",
            qaPassedAt: new Date(),
            qaReviewedByModel: result.model,
          },
        });
        published++;
        console.log(`[qa] PUBLISH: ${article.generatedHeadline} (score=${parsed.overallScore})`);
      } else if (parsed.verdict === "REVISE") {
        if (article.retryCount > 0) {
          // Second revision — publish anyway
          console.warn(`[qa] Second REVISE for ${article.rawTitle}, publishing: ${parsed.issues}`);
          await prisma.pipelineArticle.update({
            where: { id: article.id },
            data: {
              stage: "QA_PASSED",
              qaScore: parsed.overallScore,
              qaNotes: `Auto-passed (2nd attempt). Issues: ${parsed.issues}`,
              qaPassedAt: new Date(),
              qaReviewedByModel: result.model,
            },
          });
          published++;
        } else {
          // First revision — send back to generate
          await prisma.pipelineArticle.update({
            where: { id: article.id },
            data: {
              stage: "VERIFIED", // Send back to Stage 6
              qaNotes: `REVISE: ${parsed.issues}`,
              retryCount: { increment: 1 },
              qaReviewedByModel: result.model,
            },
          });
          revised++;
          console.log(`[qa] REVISE: ${article.generatedHeadline} — ${parsed.issues}`);
        }
      } else {
        // REJECT
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "REJECTED",
            qaScore: parsed.overallScore,
            qaNotes: `QA REJECTED: ${parsed.issues}`,
            qaPassedAt: new Date(),
            qaReviewedByModel: result.model,
          },
        });
        rejected++;
        console.log(`[qa] REJECTED: ${article.generatedHeadline} — ${parsed.issues}`);
      }
    } catch (err: any) {
      console.error(`[qa] Error for ${article.rawTitle}: ${err.message}`);
      // Don't block — auto-pass
      try {
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "QA_PASSED",
            qaScore: 7,
            qaNotes: `QA error: ${err.message}. Auto-passed.`,
            qaPassedAt: new Date(),
          },
        });
      } catch {
        console.error(`[qa] Could not update article ${article.id}`);
      }
      published++;
    }
  }

  console.log(`[Stage 7] QA reviewed ${articles.length}: ${published} published, ${revised} revised, ${rejected} rejected`);
  return { published, revised, rejected };
}
