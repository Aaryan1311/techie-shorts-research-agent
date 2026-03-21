export const RSS_SOURCES = [
  { name: "hackernews", url: "https://hnrss.org/newest?points=200" },
  { name: "techcrunch", url: "https://techcrunch.com/feed/" },
  { name: "theverge", url: "https://www.theverge.com/rss/index.xml" },
  { name: "github", url: "https://github.blog/feed/" },
  { name: "producthunt", url: "https://www.producthunt.com/feed" },
  { name: "techmeme", url: "https://www.techmeme.com/feed.xml" },
  { name: "lobsters", url: "https://lobste.rs/rss" },
  { name: "arstechnica", url: "https://feeds.arstechnica.com/arstechnica/technology-lab" },
  { name: "inc42", url: "https://inc42.com/feed/" },
  { name: "yourstory", url: "https://yourstory.com/feed" },
  // Research / AI blogs
  { name: "google-ai", url: "https://blog.google/technology/ai/rss/" },
  // Design / Frontend
  { name: "smashingmagazine", url: "https://www.smashingmagazine.com/feed/" },
  { name: "css-tricks", url: "https://css-tricks.com/feed/" },
  // Gadgets
  { name: "androidauthority", url: "https://www.androidauthority.com/feed/" },
];

export const REDDIT_SOURCES = [
  { name: "reddit", subreddit: "programming", minUpvotes: 500 },
  { name: "reddit", subreddit: "webdev", minUpvotes: 500 },
  { name: "reddit", subreddit: "machinelearning", minUpvotes: 500 },
  { name: "reddit", subreddit: "developersIndia", minUpvotes: 500 },
  { name: "reddit", subreddit: "AI_India", minUpvotes: 500 },
  // Competitive programming
  { name: "reddit", subreddit: "codeforces", minUpvotes: 50 },
  { name: "reddit", subreddit: "leetcode", minUpvotes: 50 },
  // Gaming
  { name: "reddit", subreddit: "gaming", minUpvotes: 1000 },
  // Design
  { name: "reddit", subreddit: "userexperience", minUpvotes: 100 },
];

export const MODEL_CONFIG = {
  classify: {
    primary: { model: "llama-3.1-8b-instant", provider: "groq" as const },
    fallback: { model: "llama-3.1-8b-instant", provider: "groq" as const },
  },
  generate: {
    primary: { model: "llama-3.3-70b-versatile", provider: "groq" as const },
    fallback: { model: "llama-3.1-8b-instant", provider: "groq" as const },
  },
  qa: {
    primary: { model: "llama-3.1-8b-instant", provider: "groq" as const },
    fallback: { model: "llama-3.1-8b-instant", provider: "groq" as const },
  },
};

export const RATE_LIMITS = {
  groq: 5000,   // 5 seconds between calls (avoid rate limits on generate)
  gemini: 5000, // 5 seconds between calls
};

export const MAX_ARTICLES_PER_RUN = 25;

export const PIPELINE_CRON = "*/30 * * * *"; // Every 30 minutes
