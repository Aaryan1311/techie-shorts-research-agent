import prisma from "../db";
import { callModel } from "../models/model-router";
import { parseJSON } from "../models/groq";
import { MAX_ARTICLES_PER_RUN, SOURCE_TRUST } from "../config";

const VERIFY_SYSTEM_PROMPT = `You are a fact-checking editor. Review this article and score it on these dimensions.

Return ONLY valid JSON:
{
  "headlineAccuracy": 1-10,
  "specificity": 1-10,
  "sensationalism": 1-10,
  "overallVerdict": "PASS" | "FAIL",
  "notes": "one line explanation"
}

SCORING:
- headlineAccuracy: Does the headline accurately represent the content? 10 = perfectly accurate, 1 = misleading clickbait. "Microsoft KILLS Windows" when they just delayed a feature = 2. "Microsoft delays Windows 11 feature" = 9.
- specificity: Does the article have specific details? Names, dates, numbers, quotes, version numbers? 10 = very specific with concrete facts. 1 = vague "sources say something might happen"
- sensationalism: How sensationalist is the language? 10 = calm, factual tone. 1 = "SHOCKING! You Won't BELIEVE what happened!" Invert this — high score = GOOD (less sensational)
- overallVerdict: PASS if the article is worth publishing. FAIL if it's misleading, too vague, or low quality.

Be strict but fair. Real news from reputable sources should usually PASS. Clickbait and vague rumors should FAIL.`;

interface VerifyResult {
  headlineAccuracy: number;
  specificity: number;
  sensationalism: number;
  overallVerdict: "PASS" | "FAIL";
  notes: string;
}

export async function runVerifyStage(): Promise<{ passed: number; failed: number }> {
  console.log("[Stage 5] Verifying articles...");

  const articles = await prisma.pipelineArticle.findMany({
    where: { stage: "DEDUPED" },
    orderBy: { createdAt: "asc" },
    take: MAX_ARTICLES_PER_RUN,
  });

  if (articles.length === 0) {
    console.log("[Stage 5] No articles to verify");
    return { passed: 0, failed: 0 };
  }

  let passed = 0;
  let failed = 0;

  for (const article of articles) {
    try {
      const sourceTrust = SOURCE_TRUST[article.source] ?? 5;

      // Build content preview
      const contentPreview = article.fullArticleText
        ? article.fullArticleText.split(/\s+/).slice(0, 500).join(" ")
        : article.rawDescription ?? "N/A";

      const userPrompt = `Title: ${article.rawTitle}\nSource: ${article.source}\nContent preview: ${contentPreview}`;

      // 3 second delay between LLM calls
      await new Promise((r) => setTimeout(r, 3000));

      const result = await callModel("classify", VERIFY_SYSTEM_PROMPT, userPrompt);

      if (!result) {
        // LLM failed — default to PASS based on source trust alone
        const trustScore = sourceTrust;
        console.warn(`[verify] LLM failed for ${article.rawTitle}, using source trust (${trustScore})`);
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "VERIFIED",
            verificationScore: trustScore,
            verificationNotes: "Verification skipped — LLM error. Score based on source trust.",
            verifiedAt: new Date(),
          },
        });
        passed++;
        continue;
      }

      const parsed = parseJSON<VerifyResult>(result.response);

      if (!parsed) {
        // Parse failed — default to PASS based on source trust
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "VERIFIED",
            verificationScore: sourceTrust,
            verificationNotes: "Verification skipped — unparseable response. Score based on source trust.",
            verifiedAt: new Date(),
            verifiedByModel: result.model,
          },
        });
        passed++;
        continue;
      }

      // Compute final score: sourceTrust*0.3 + headlineAccuracy*0.3 + specificity*0.2 + sensationalism*0.2
      const verificationScore = Math.round(
        sourceTrust * 0.3 +
        (parsed.headlineAccuracy ?? 5) * 0.3 +
        (parsed.specificity ?? 5) * 0.2 +
        (parsed.sensationalism ?? 5) * 0.2
      );

      if (parsed.overallVerdict === "FAIL" || verificationScore < 5.5) {
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "REJECTED",
            verificationScore,
            verificationNotes: parsed.notes ?? "Failed verification",
            verifiedAt: new Date(),
            verifiedByModel: result.model,
          },
        });
        failed++;
        console.log(`[verify] REJECTED: ${article.rawTitle} (score=${verificationScore}, ${parsed.notes})`);
      } else {
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "VERIFIED",
            verificationScore,
            verificationNotes: parsed.notes ?? "Passed verification",
            verifiedAt: new Date(),
            verifiedByModel: result.model,
          },
        });
        passed++;
        console.log(`[verify] PASSED: ${article.rawTitle} (score=${verificationScore})`);
      }
    } catch (err: any) {
      console.error(`[verify] Error for ${article.rawTitle}: ${err.message}`);
      // Don't block — auto-pass with source trust score
      const sourceTrust = SOURCE_TRUST[article.source] ?? 5;
      try {
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "VERIFIED",
            verificationScore: sourceTrust,
            verificationNotes: `Verification error: ${err.message}. Score based on source trust.`,
            verifiedAt: new Date(),
          },
        });
      } catch {
        console.error(`[verify] Could not update article ${article.id}`);
      }
      passed++;
    }
  }

  console.log(`[Stage 5] Verified ${articles.length}: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}
