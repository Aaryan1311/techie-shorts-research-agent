import crypto from "crypto";
import { Prisma } from "@prisma/client";
import prisma from "../db";

function generateCuid(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 25);
}

function isArticleComplete(article: any): { complete: boolean; missing: string[] } {
  const missing: string[] = [];

  if (!article.generatedHeadline || article.generatedHeadline.trim().length < 10) {
    missing.push("headline");
  }
  if (!article.generatedSummary || article.generatedSummary.trim().length < 100) {
    missing.push(`summary (too short: ${article.generatedSummary?.length || 0} chars)`);
  }
  if (!article.generatedDetail || article.generatedDetail.trim().length < 200) {
    missing.push(`detailContent (too short: ${article.generatedDetail?.length || 0} chars)`);
  }
  if (!article.generatedWhatsNext || article.generatedWhatsNext.trim().length < 100) {
    missing.push(`whatsNext (too short: ${article.generatedWhatsNext?.length || 0} chars)`);
  }

  return { complete: missing.length === 0, missing };
}

export async function runPublishStage(): Promise<{ published: number; sentBack: number }> {
  console.log("[Stage 8] Publishing articles...");

  const articles = await prisma.pipelineArticle.findMany({
    where: { stage: "QA_PASSED" },
    orderBy: { qaPassedAt: "asc" },
  });

  if (articles.length === 0) {
    console.log("[Stage 8] No articles to publish");
    return { published: 0, sentBack: 0 };
  }

  let published = 0;
  let sentBack = 0;

  for (const article of articles) {
    try {
      // Validate completeness before publishing
      const { complete, missing } = isArticleComplete(article);
      if (!complete) {
        console.warn(`[publish] INCOMPLETE: ${article.rawTitle} — missing: ${missing.join(", ")}. Sent back to generate.`);
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "VERIFIED", // Send back to Stage 6
            retryCount: { increment: 1 },
          },
        });
        sentBack++;
        continue;
      }

      // Check if already published to news table
      const existing = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM news WHERE "sourceUrl" = ${article.sourceUrl} LIMIT 1
      `;

      if (existing.length > 0) {
        console.log(`[publish] Already in news table, skipping: ${article.sourceUrl}`);
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "PUBLISHED",
            publishedNewsId: existing[0].id,
            publishedAt: new Date(),
          },
        });
        published++;
        continue;
      }

      // Create the news row via raw SQL
      const newsId = generateCuid();
      const title = article.generatedHeadline ?? article.rawTitle;
      const summary = article.generatedSummary ?? "";
      const detailContent = article.generatedDetail ?? null;
      const futureImpact = article.generatedWhatsNext ?? null;
      const buildOnThis = article.generatedBuildOnThis ?? null;
      const sourceUrl = article.sourceUrl;
      const imageUrl = article.imageUrl ?? null;
      const source = article.source;
      const trendingScore = article.trendingScore ?? null;
      const qualityScore = article.qualityScore ?? null;
      const relevanceScore = article.relevanceScore ?? null;

      await prisma.$executeRaw`
        INSERT INTO news (id, title, summary, "detailContent", "futureImpact", "buildOnThis", "sourceUrl", "imageUrl", source, "isActive", "trendingScore", "qualityScore", "relevanceScore", "publishedAt", "createdAt", "updatedAt")
        VALUES (${newsId}, ${title}, ${summary}, ${detailContent}, ${futureImpact}, ${buildOnThis}, ${sourceUrl}, ${imageUrl}, ${source}, true, ${trendingScore}::int, ${qualityScore}::int, ${relevanceScore}::int, NOW(), NOW(), NOW())
      `;

      // Associate tags via raw SQL
      let tagSlugs: string[] = [];
      try {
        tagSlugs = JSON.parse(article.suggestedTags ?? "[]");
      } catch {
        tagSlugs = [];
      }

      if (tagSlugs.length > 0) {
        const tags = await prisma.$queryRaw<{ id: string; slug: string }[]>`
          SELECT id, slug FROM tags WHERE slug = ANY(${tagSlugs}::text[])
        `;

        for (const tag of tags) {
          await prisma.$executeRaw`
            INSERT INTO news_tags ("newsId", "tagId")
            VALUES (${newsId}, ${tag.id})
            ON CONFLICT ("newsId", "tagId") DO NOTHING
          `;
        }
      }

      // Update pipeline article
      await prisma.pipelineArticle.update({
        where: { id: article.id },
        data: {
          stage: "PUBLISHED",
          publishedNewsId: newsId,
          publishedAt: new Date(),
        },
      });

      published++;
      console.log(`[publish] Published: ${title}`);
    } catch (err: any) {
      // Unique constraint on source_url — already published
      if (err.code === "P2002" || err.message?.includes("unique constraint")) {
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: { stage: "PUBLISHED", publishedAt: new Date() },
        });
        published++;
        continue;
      }

      console.error(`[publish] Error publishing ${article.rawTitle}: ${err.message}`);
      await prisma.pipelineArticle.update({
        where: { id: article.id },
        data: {
          stage: "FAILED",
          failedAt: new Date(),
          failureReason: `Publish error: ${err.message}`,
          retryCount: { increment: 1 },
        },
      });
    }
  }

  console.log(`[Stage 8] Published ${published}, sent back ${sentBack} incomplete`);
  return { published, sentBack };
}
