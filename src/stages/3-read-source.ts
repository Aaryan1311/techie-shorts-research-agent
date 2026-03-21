import { extract } from "@extractus/article-extractor";
import * as cheerio from "cheerio";
import prisma from "../db";
import { MAX_ARTICLES_PER_RUN } from "../config";

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; TechieShorts/1.0; +https://techin-shorts.vercel.app)",
  "Accept": "text/html,application/xhtml+xml",
};

const FETCH_TIMEOUT = 10_000; // 10 seconds

const BOILERPLATE_PATTERNS = [
  /subscribe to our newsletter/gi,
  /sign up for our newsletter/gi,
  /share this article/gi,
  /related articles/gi,
  /cookie consent/gi,
  /accept cookies/gi,
  /we use cookies/gi,
  /advertisement/gi,
  /sponsored content/gi,
  /click here to/gi,
  /follow us on/gi,
  /join our community/gi,
];

function cleanText(raw: string): string {
  // Strip HTML tags
  let text = raw.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Remove boilerplate
  for (const pattern of BOILERPLATE_PATTERNS) {
    text = text.replace(pattern, "");
  }

  // Normalize whitespace
  text = text.replace(/\s+/g, " ").trim();

  // Truncate to first 2000 words
  const words = text.split(/\s+/);
  if (words.length > 2000) {
    text = words.slice(0, 2000).join(" ");
  }

  return text;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function extractWithCheerio(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const response = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove scripts, styles, nav, footer, aside
    $("script, style, nav, footer, aside, header, .sidebar, .ad, .advertisement").remove();

    // Try common article containers
    let text = "";
    const selectors = ["article", "main", '[role="main"]', ".post-content", ".article-content", ".entry-content"];
    for (const sel of selectors) {
      const el = $(sel);
      if (el.length > 0) {
        text = el.text();
        break;
      }
    }

    // Fallback: all <p> tags
    if (!text || text.trim().length < 100) {
      text = $("p").map((_, el) => $(el).text()).get().join("\n");
    }

    return text && text.trim().length > 50 ? text : null;
  } catch {
    return null;
  }
}

export async function runReadSourceStage(): Promise<{ success: number; failed: number }> {
  console.log("[Stage 3] Reading source articles...");

  const articles = await prisma.pipelineArticle.findMany({
    where: { stage: "CLASSIFIED" },
    orderBy: { createdAt: "asc" },
    take: MAX_ARTICLES_PER_RUN,
  });

  if (articles.length === 0) {
    console.log("[Stage 3] No articles to read");
    return { success: 0, failed: 0 };
  }

  let success = 0;
  let failed = 0;
  let lastDomain = "";

  for (const article of articles) {
    try {
      // Rate limiting: 2s between fetches, extra 3s for same domain
      const domain = extractDomain(article.sourceUrl);
      if (domain === lastDomain) {
        await new Promise((r) => setTimeout(r, 5000));
      } else {
        await new Promise((r) => setTimeout(r, 2000));
      }
      lastDomain = domain;

      let fullText: string | null = null;

      // Primary: article-extractor
      try {
        const extracted = await extract(article.sourceUrl);
        if (extracted?.content) {
          fullText = cleanText(extracted.content);
        }
        if (!fullText && extracted?.description) {
          fullText = cleanText(extracted.description);
        }
      } catch (err: any) {
        console.warn(`[read-source] Extractor failed for ${article.sourceUrl}: ${err.message}`);
      }

      // Fallback: cheerio
      if (!fullText || fullText.length < 100) {
        try {
          const cheerioText = await extractWithCheerio(article.sourceUrl);
          if (cheerioText) {
            fullText = cleanText(cheerioText);
          }
        } catch (err: any) {
          console.warn(`[read-source] Cheerio failed for ${article.sourceUrl}: ${err.message}`);
        }
      }

      // Last resort: keep rawDescription
      const readSuccess = !!(fullText && fullText.length >= 100);
      if (!readSuccess) {
        fullText = article.rawDescription ?? null;
      }

      await prisma.pipelineArticle.update({
        where: { id: article.id },
        data: {
          stage: "SOURCE_READ",
          fullArticleText: fullText,
          sourceReadAt: new Date(),
          sourceReadSuccess: readSuccess,
        },
      });

      if (readSuccess) {
        success++;
        console.log(`[read-source] OK: ${article.rawTitle} (${fullText!.split(/\s+/).length} words)`);
      } else {
        failed++;
        console.log(`[read-source] FALLBACK: ${article.rawTitle} (using description)`);
      }
    } catch (err: any) {
      console.error(`[read-source] Error for ${article.rawTitle}: ${err.message}`);
      // Don't crash — mark as read with failure and continue
      try {
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "SOURCE_READ",
            sourceReadAt: new Date(),
            sourceReadSuccess: false,
            fullArticleText: article.rawDescription ?? null,
          },
        });
      } catch {
        console.error(`[read-source] Could not update article ${article.id}`);
      }
      failed++;
    }
  }

  console.log(`[Stage 3] Read ${articles.length} articles: ${success} successful, ${failed} failed`);
  return { success, failed };
}
