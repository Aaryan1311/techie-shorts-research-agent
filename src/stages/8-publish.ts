import prisma from "../db";

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
      const existing = await prisma.news.findUnique({
        where: { sourceUrl: article.sourceUrl },
        select: { id: true },
      });

      if (existing) {
        console.log(`[publish] Already in news table, skipping: ${article.sourceUrl}`);
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "PUBLISHED",
            publishedNewsId: existing.id,
            publishedAt: new Date(),
          },
        });
        published++;
        continue;
      }

      // Create the news row
      const newsRow = await prisma.news.create({
        data: {
          title: article.generatedHeadline ?? article.rawTitle,
          summary: article.generatedSummary ?? "",
          detailContent: article.generatedDetail ?? null,
          futureImpact: article.generatedWhatsNext ?? null,
          buildOnThis: article.generatedBuildOnThis ?? null,
          sourceUrl: article.sourceUrl,
          imageUrl: article.imageUrl ?? null,
          source: article.source,
          isActive: true,
          trendingScore: article.trendingScore ?? null,
          qualityScore: article.qualityScore ?? null,
          relevanceScore: article.relevanceScore ?? null,
          publishedAt: new Date(),
        },
      });

      // Associate tags
      let tagSlugs: string[] = [];
      try {
        tagSlugs = JSON.parse(article.suggestedTags ?? "[]");
      } catch {
        tagSlugs = [];
      }

      if (tagSlugs.length > 0) {
        const tags = await prisma.tag.findMany({
          where: { slug: { in: tagSlugs } },
        });

        if (tags.length > 0) {
          await prisma.newsTag.createMany({
            data: tags.map((tag) => ({
              newsId: newsRow.id,
              tagId: tag.id,
            })),
            skipDuplicates: true,
          });
        }
      }

      // Update pipeline article
      await prisma.pipelineArticle.update({
        where: { id: article.id },
        data: {
          stage: "PUBLISHED",
          publishedNewsId: newsRow.id,
          publishedAt: new Date(),
        },
      });

      published++;
      console.log(`[publish] Published: ${newsRow.title}`);
    } catch (err: any) {
      // Unique constraint on source_url — already published
      if (err.code === "P2002") {
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
