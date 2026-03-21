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
];

export const REDDIT_SOURCES = [
  { name: "reddit", subreddit: "programming" },
  { name: "reddit", subreddit: "webdev" },
  { name: "reddit", subreddit: "machinelearning" },
  { name: "reddit", subreddit: "developersIndia" },
  { name: "reddit", subreddit: "AI_India" },
];

export const REDDIT_MIN_UPVOTES = 500;

export const MODEL_CONFIG = {
  classify: {
    primary: { model: "llama-3.1-8b-instant", provider: "groq" as const },
    fallback: { model: "gemini-2.0-flash", provider: "gemini" as const },
  },
  generate: {
    primary: { model: "llama-3.1-70b-versatile", provider: "groq" as const },
    fallback: { model: "gemini-2.0-flash", provider: "gemini" as const },
  },
  qa: {
    primary: { model: "gemini-2.0-flash", provider: "gemini" as const },
    fallback: { model: "llama-3.1-8b-instant", provider: "groq" as const },
  },
};

export const RATE_LIMITS = {
  groq: 3000,   // 3 seconds between calls
  gemini: 5000, // 5 seconds between calls
};

export const MAX_ARTICLES_PER_RUN = 15;

export const PIPELINE_CRON = "*/30 * * * *"; // Every 30 minutes
