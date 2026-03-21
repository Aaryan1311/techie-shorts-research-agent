import prisma from "../db";
import { callModel } from "../models/model-router";
import { parseJSON } from "../models/groq";
import { MAX_ARTICLES_PER_RUN } from "../config";

const CLASSIFY_SYSTEM_PROMPT = `You are a senior tech news editor. Evaluate this article and return ONLY valid JSON:

{
  "isNews": true/false,
  "articleType": "PRODUCT_LAUNCH" | "BUSINESS" | "SECURITY" | "STATEMENT" | "DEEP_TECH",
  "qualityScore": 1-10,
  "relevanceScore": 1-10,
  "trendingScore": 1-10,
  "reasoning": "one line explanation",
  "suggestedTags": ["tag-slug-1", "tag-slug-2"],
  "isTrending": true/false
}

RULES:
- isNews=true ONLY for: product launches, major updates, security vulnerabilities, funding, acquisitions, new releases, breaking changes, company announcements, layoffs, government tech policy
- isNews=false for: tutorials, how-to guides, opinion pieces, listicles, personal blogs, beginner guides, job postings
- ONLY tech-related news. Jeff Bezos buying non-tech companies is NOT tech news. Space news is NOT tech news unless directly about software/AI.
- qualityScore 8-10 = must-read, 5-7 = interesting, 1-4 = low quality
- Pick ONLY 1-2 tags from: ai-ml, python, javascript, node-js, frontend, backend, devops, cloud, cybersecurity, databases, open-source, career-jobs
- isTrending = true only if trendingScore >= 8 AND qualityScore >= 7`;

interface ClassifyResult {
  isNews: boolean;
  articleType: string;
  qualityScore: number;
  relevanceScore: number;
  trendingScore: number;
  reasoning: string;
  suggestedTags: string[];
  isTrending: boolean;
}

export async function runClassifyStage(): Promise<{ passed: number; rejected: number }> {
  console.log("[Stage 2] Classifying articles...");

  const articles = await prisma.pipelineArticle.findMany({
    where: { stage: "FETCHED" },
    orderBy: { createdAt: "asc" },
    take: MAX_ARTICLES_PER_RUN,
  });

  if (articles.length === 0) {
    console.log("[Stage 2] No articles to classify");
    return { passed: 0, rejected: 0 };
  }

  let passed = 0;
  let rejected = 0;

  for (const article of articles) {
    try {
      const userPrompt = `Title: ${article.rawTitle}\nDescription: ${article.rawDescription ?? "N/A"}\nSource: ${article.source}`;

      const result = await callModel("classify", CLASSIFY_SYSTEM_PROMPT, userPrompt);

      if (!result) {
        console.warn(`[classify] No response for: ${article.rawTitle}`);
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "FAILED",
            failedAt: new Date(),
            failureReason: "Classification model returned no response",
            retryCount: { increment: 1 },
          },
        });
        continue;
      }

      const parsed = parseJSON<ClassifyResult>(result.response);

      if (!parsed) {
        console.warn(`[classify] Failed to parse response for: ${article.rawTitle}`);
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "FAILED",
            failedAt: new Date(),
            failureReason: "Failed to parse classification JSON",
            retryCount: { increment: 1 },
          },
        });
        continue;
      }

      if (!parsed.isNews || parsed.qualityScore < 6) {
        // Reject
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "REJECTED",
            classificationReason: parsed.reasoning ?? "Not qualifying news",
            qualityScore: parsed.qualityScore,
            relevanceScore: parsed.relevanceScore,
            trendingScore: parsed.trendingScore,
            classifiedAt: new Date(),
            classifiedByModel: result.model,
          },
        });
        rejected++;
        console.log(`[classify] REJECTED: ${article.rawTitle} (quality=${parsed.qualityScore})`);
      } else {
        // Pass
        const validTypes = ["PRODUCT_LAUNCH", "BUSINESS", "SECURITY", "STATEMENT", "DEEP_TECH"];
        const articleType = validTypes.includes(parsed.articleType)
          ? (parsed.articleType as any)
          : "DEEP_TECH";

        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "CLASSIFIED",
            articleType,
            qualityScore: parsed.qualityScore,
            relevanceScore: parsed.relevanceScore,
            trendingScore: parsed.trendingScore,
            classificationReason: parsed.reasoning,
            classifiedAt: new Date(),
            classifiedByModel: result.model,
            suggestedTags: JSON.stringify(parsed.suggestedTags ?? []),
          },
        });
        passed++;
        console.log(
          `[classify] PASSED: ${article.rawTitle} → ${articleType} (quality=${parsed.qualityScore})`
        );
      }
    } catch (err: any) {
      console.error(`[classify] Error processing ${article.rawTitle}: ${err.message}`);
      await prisma.pipelineArticle.update({
        where: { id: article.id },
        data: {
          stage: "FAILED",
          failedAt: new Date(),
          failureReason: `Classification error: ${err.message}`,
          retryCount: { increment: 1 },
        },
      });
    }
  }

  console.log(`[Stage 2] Classified ${articles.length}: ${passed} passed, ${rejected} rejected`);
  return { passed, rejected };
}
