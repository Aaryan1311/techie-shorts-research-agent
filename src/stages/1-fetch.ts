import RSSParser from "rss-parser";
import he from "he";
import prisma from "../db";
import { RSS_SOURCES, REDDIT_SOURCES } from "../config";

const parser = new RSSParser({
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: false }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: false }],
    ],
  },
});

interface FeedItem {
  title: string;
  description?: string;
  url: string;
  imageUrl: string | null;
  source: string;
}

function extractImageUrl(item: any): string | null {
  // Check enclosure
  if (item.enclosure?.url) return item.enclosure.url;

  // Check media:content
  if (item.mediaContent?.["$"]?.url) return item.mediaContent["$"].url;

  // Check media:thumbnail
  if (item.mediaThumbnail?.["$"]?.url) return item.mediaThumbnail["$"].url;

  // Try to extract first <img> from content/description HTML
  const html = item["content:encoded"] || item.content || item.description || "";
  const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch?.[1]) return imgMatch[1];

  return null;
}

async function fetchRSSFeeds(): Promise<FeedItem[]> {
  const items: FeedItem[] = [];

  for (const source of RSS_SOURCES) {
    try {
      const feed = await parser.parseURL(source.url);
      for (const entry of feed.items) {
        if (!entry.link) continue;

        items.push({
          title: he.decode(entry.title ?? ""),
          description: entry.contentSnippet
            ? he.decode(entry.contentSnippet.slice(0, 500))
            : undefined,
          url: entry.link,
          imageUrl: extractImageUrl(entry),
          source: source.name,
        });
      }
      console.log(`[fetch] ${source.name}: ${feed.items.length} items`);
    } catch (err: any) {
      console.warn(`[fetch] Failed to fetch ${source.name}: ${err.message}`);
    }
  }

  return items;
}

async function fetchRedditFeeds(): Promise<FeedItem[]> {
  const items: FeedItem[] = [];

  for (const source of REDDIT_SOURCES) {
    try {
      const response = await fetch(
        `https://www.reddit.com/r/${source.subreddit}/hot.json?limit=25`,
        {
          headers: {
            "User-Agent": "TechieShorts/1.0 (research-agent)",
          },
        }
      );

      if (!response.ok) {
        console.warn(`[fetch] Reddit r/${source.subreddit}: HTTP ${response.status}`);
        continue;
      }

      const data: any = await response.json();
      const posts = data?.data?.children ?? [];

      for (const post of posts) {
        const d = post.data;

        // Skip self-posts, NSFW, and low-upvote posts
        if (d.is_self) continue;
        if (d.over_18) continue;
        if (d.ups < source.minUpvotes) continue;
        if (!d.url) continue;

        // Skip reddit-internal links
        if (d.url.includes("reddit.com") || d.url.includes("redd.it")) continue;

        items.push({
          title: he.decode(d.title ?? ""),
          description: d.selftext
            ? he.decode(d.selftext.slice(0, 500))
            : undefined,
          url: d.url,
          imageUrl: d.thumbnail && d.thumbnail !== "default" && d.thumbnail !== "self"
            ? d.thumbnail
            : null,
          source: "reddit",
        });
      }
      console.log(
        `[fetch] reddit/r/${source.subreddit}: ${posts.length} posts, ${items.length} qualifying`
      );
    } catch (err: any) {
      console.warn(`[fetch] Failed to fetch reddit r/${source.subreddit}: ${err.message}`);
    }
  }

  return items;
}

export async function runFetchStage(): Promise<number> {
  console.log("[Stage 1] Fetching feeds...");

  const [rssItems, redditItems] = await Promise.all([
    fetchRSSFeeds(),
    fetchRedditFeeds(),
  ]);

  const allItems = [...rssItems, ...redditItems];
  let newCount = 0;

  for (const item of allItems) {
    try {
      // Check if already exists
      const existing = await prisma.pipelineArticle.findUnique({
        where: { sourceUrl: item.url },
        select: { id: true },
      });

      if (existing) continue;

      await prisma.pipelineArticle.create({
        data: {
          sourceUrl: item.url,
          source: item.source,
          rawTitle: item.title,
          rawDescription: item.description ?? null,
          imageUrl: item.imageUrl ?? null,
          stage: "FETCHED",
        },
      });
      newCount++;
    } catch (err: any) {
      // Unique constraint violation — another run already inserted it
      if (err.code === "P2002") continue;
      console.warn(`[fetch] Error saving ${item.url}: ${err.message}`);
    }
  }

  console.log(`[Stage 1] Fetched ${allItems.length} items, ${newCount} new`);
  return newCount;
}
