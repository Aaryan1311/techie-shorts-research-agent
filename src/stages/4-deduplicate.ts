import prisma from "../db";
import { callModel } from "../models/model-router";
import { parseJSON } from "../models/groq";
import { MAX_ARTICLES_PER_RUN } from "../config";

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "for", "in", "on", "at",
  "to", "of", "with", "and", "or", "by", "its", "has", "had", "have",
  "new", "from", "that", "this", "it", "be", "as", "but", "not", "will",
  "can", "may", "about", "more", "than", "into", "over", "after", "just",
  "also", "been", "their", "which", "would", "could", "should", "all",
  "some", "any", "each", "most", "other", "no", "up", "out", "if", "when",
  "how", "what", "who", "why", "where",
]);

function extractSignificantWords(title: string): string[] {
  return title
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function countOverlap(wordsA: string[], wordsB: string[]): number {
  const setB = new Set(wordsB);
  return wordsA.filter((w) => setB.has(w)).length;
}

const DEDUP_SYSTEM_PROMPT = `Compare these two articles. Are they about the SAME event or DIFFERENT events?

Return ONLY valid JSON:
{
  "verdict": "SAME" | "DIFFERENT" | "UPDATE",
  "reasoning": "one line explanation"
}

SAME = exact same event, no new information
DIFFERENT = different topics that share some keywords
UPDATE = same event but new article has significantly newer/more detailed information`;

interface DedupResult {
  verdict: "SAME" | "DIFFERENT" | "UPDATE";
  reasoning: string;
}

interface RecentArticle {
  title: string;
  summary: string | null;
  id: string;
  source: string | null;
}

export async function runDeduplicateStage(): Promise<{ unique: number; duplicates: number; updates: number }> {
  console.log("[Stage 4] Deduplicating articles...");

  const articles = await prisma.pipelineArticle.findMany({
    where: { stage: "SOURCE_READ" },
    orderBy: { sourceReadAt: "asc" },
    take: MAX_ARTICLES_PER_RUN,
  });

  if (articles.length === 0) {
    console.log("[Stage 4] No articles to deduplicate");
    return { unique: 0, duplicates: 0, updates: 0 };
  }

  // Get recent comparison pool — wrapped in try/catch so dedup doesn't crash
  let recentPool: RecentArticle[] = [];
  try {
    const recentNews = await prisma.$queryRaw<{ id: string; title: string; summary: string | null; source: string | null }[]>`
      SELECT id, title, summary, source FROM news
      WHERE "publishedAt" > NOW() - INTERVAL '12 hours'
    `;

    const recentPipeline = await prisma.pipelineArticle.findMany({
      where: {
        stage: { in: ["DEDUPED", "CONTENT_GENERATED", "PUBLISHED"] },
        updatedAt: { gte: new Date(Date.now() - 12 * 60 * 60 * 1000) },
      },
      select: {
        id: true,
        rawTitle: true,
        generatedSummary: true,
        source: true,
      },
    });

    recentPool = [
      ...recentNews.map((n) => ({ title: n.title, summary: n.summary, id: n.id, source: n.source })),
      ...recentPipeline.map((p) => ({ title: p.rawTitle, summary: p.generatedSummary, id: p.id, source: p.source })),
    ];
  } catch (poolErr: any) {
    console.warn(`[dedup] Failed to fetch comparison pool: ${poolErr.message}`);
    console.warn("[dedup] Auto-promoting all SOURCE_READ articles to DEDUPED");
    await prisma.pipelineArticle.updateMany({
      where: { stage: "SOURCE_READ" },
      data: {
        stage: "DEDUPED",
        isDuplicate: false,
        deduplicationReason: "Skipped dedup: comparison pool fetch failed",
        deduplicatedAt: new Date(),
      },
    });
    return { unique: articles.length, duplicates: 0, updates: 0 };
  }

  let unique = 0;
  let duplicates = 0;
  let updates = 0;

  for (const article of articles) {
    try {
      const newWords = extractSignificantWords(article.rawTitle);

      // Find potential duplicates by keyword overlap
      // Threshold: 2+ keyword matches, or 1+ if same source domain
      let bestMatch: { article: RecentArticle; overlap: number } | null = null;

      for (const recent of recentPool) {
        const recentWords = extractSignificantWords(recent.title);
        const overlap = countOverlap(newWords, recentWords);

        const sameSource = !!(article.source && recent.source && article.source === recent.source);
        const threshold = sameSource ? 1 : 2;

        if (overlap >= threshold) {
          if (!bestMatch || overlap > bestMatch.overlap) {
            bestMatch = { article: recent, overlap };
          }
        }
      }

      if (!bestMatch) {
        // No keyword match — automatically unique
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "DEDUPED",
            isDuplicate: false,
            deduplicatedAt: new Date(),
          },
        });
        unique++;
        // Add to pool so subsequent articles in this batch can dedup against it
        recentPool.push({ title: article.rawTitle, summary: article.rawDescription, id: article.id, source: article.source });
        continue;
      }

      // Keyword match found — ask LLM to confirm
      const userPrompt = `Article A (already published):\nTitle: ${bestMatch.article.title}\nSummary: ${bestMatch.article.summary ?? "N/A"}\n\nArticle B (new):\nTitle: ${article.rawTitle}\nDescription: ${article.rawDescription ?? "N/A"}`;

      // 2 second delay before LLM call
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const result = await callModel("classify", DEDUP_SYSTEM_PROMPT, userPrompt);

      if (!result) {
        // If LLM fails, let it through
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "DEDUPED",
            isDuplicate: false,
            deduplicationReason: "LLM dedup check failed, letting through",
            deduplicatedAt: new Date(),
          },
        });
        unique++;
        continue;
      }

      const parsed = parseJSON<DedupResult>(result.response);

      if (!parsed) {
        // Parse failed — let it through
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "DEDUPED",
            isDuplicate: false,
            deduplicationReason: "Failed to parse dedup response, letting through",
            deduplicatedAt: new Date(),
          },
        });
        unique++;
        continue;
      }

      if (parsed.verdict === "SAME") {
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "DUPLICATE",
            isDuplicate: true,
            duplicateOfId: bestMatch.article.id,
            deduplicationReason: parsed.reasoning,
            deduplicatedAt: new Date(),
          },
        });
        duplicates++;
        console.log(`[dedup] DUPLICATE: "${article.rawTitle}" ← matches "${bestMatch.article.title}"`);
      } else if (parsed.verdict === "UPDATE") {
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "DEDUPED",
            isDuplicate: false,
            deduplicationReason: `UPDATE: ${parsed.reasoning}`,
            deduplicatedAt: new Date(),
          },
        });
        updates++;
        recentPool.push({ title: article.rawTitle, summary: article.rawDescription, id: article.id, source: article.source });
        console.log(`[dedup] UPDATE: "${article.rawTitle}" (more detail than existing)`);
      } else {
        // DIFFERENT
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "DEDUPED",
            isDuplicate: false,
            deduplicationReason: parsed.reasoning,
            deduplicatedAt: new Date(),
          },
        });
        unique++;
        recentPool.push({ title: article.rawTitle, summary: article.rawDescription, id: article.id, source: article.source });
      }
    } catch (err: any) {
      console.error(`[dedup] Error processing ${article.rawTitle}: ${err.message}`);
      // On error, let it through
      await prisma.pipelineArticle.update({
        where: { id: article.id },
        data: {
          stage: "DEDUPED",
          isDuplicate: false,
          deduplicationReason: `Error during dedup: ${err.message}`,
          deduplicatedAt: new Date(),
        },
      });
      unique++;
    }
  }

  console.log(`[Stage 4] Deduped ${articles.length}: ${unique} unique, ${duplicates} duplicates, ${updates} updates`);
  return { unique, duplicates, updates };
}
