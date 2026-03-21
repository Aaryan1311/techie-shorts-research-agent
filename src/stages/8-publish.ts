import crypto from "crypto";
import { Prisma } from "@prisma/client";
import prisma from "../db";

function generateCuid(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 25);
}

export async function runPublishStage(): Promise<number> {
  console.log("[Stage 8] Publishing articles...");

  const articles = await prisma.pipelineArticle.findMany({
    where: { stage: "CONTENT_GENERATED" },
    orderBy: { generatedAt: "asc" },
  });

  if (articles.length === 0) {
    console.log("[Stage 8] No articles to publish");
    return 0;
  }

  let published = 0;

  for (const article of articles) {
    try {
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
          const newsTagId = generateCuid();
          await prisma.$executeRaw`
            INSERT INTO news_tags (id, "newsId", "tagId")
            VALUES (${newsTagId}, ${newsId}, ${tag.id})
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

  console.log(`[Stage 8] Published ${published}/${articles.length} articles`);
  return published;
}
