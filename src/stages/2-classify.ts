import prisma from "../db";
import { callModel } from "../models/model-router";
import { parseJSON } from "../models/groq";
import { MAX_ARTICLES_PER_RUN } from "../config";
import { hasBudget, getBudgetStatus } from "../utils/tokenBudget";

const CLASSIFY_SYSTEM_PROMPT = `You are the chief editor of Techie Shorts — a tech culture news app for people who work in and around technology. Your audience includes developers, designers, PMs, QA engineers, data analysts, DevOps engineers, competitive programmers, tech founders, and anyone passionate about technology.

Your job: decide if this article is INTERESTING and WELL-WRITTEN enough to show to tech professionals. We accept a BROAD range of topics — what matters is QUALITY and RELEVANCE to the tech world.

Return ONLY valid JSON:
{
  "isNews": true/false,
  "articleType": "PRODUCT_LAUNCH" | "BUSINESS" | "SECURITY" | "STATEMENT" | "DEEP_TECH" | "COMPETITIVE_PROGRAMMING" | "GAMING_GADGETS" | "DESIGN" | "RESEARCH" | "COOL_TECH" | "CAREER_CULTURE",
  "qualityScore": 1-10,
  "relevanceScore": 1-10,
  "trendingScore": 1-10,
  "reasoning": "one line explanation",
  "suggestedTags": ["tag-slug-1", "tag-slug-2"],
  "isTrending": true/false
}

CONTENT WE ACCEPT (if quality is 7+):

CORE TECH:
- Software releases, framework updates, language versions, API changes
- Cloud platform changes (AWS, GCP, Azure)
- Developer tools and productivity software
- Open source project milestones

AI & MACHINE LEARNING:
- AI model launches and updates (GPT, Claude, Gemini, Llama, etc.)
- AI startup news, funding, and acquisitions
- AI regulation and policy
- New AI capabilities and demos

SECURITY:
- Data breaches, vulnerabilities, hacks
- Cybersecurity tool releases
- Privacy regulations and their impact

BUSINESS & STARTUPS:
- Funding rounds for tech/software/AI startups (especially Indian startups)
- Tech company acquisitions and mergers
- Layoffs at tech companies
- IPOs and major business moves

TECH PERSONALITIES:
- Statements and actions by tech leaders (Musk, Bezos, Altman, Pichai, Nadella, etc.)
- Leadership changes at tech companies
- Controversies involving tech figures
- Their actions that could impact markets or the tech industry

COMPETITIVE PROGRAMMING:
- Codeforces contest announcements and results
- LeetCode platform updates
- ICPC regionals and world finals
- IOI results
- Google Code Jam, Meta Hacker Cup results
- Top competitive programmer achievements
- New competitive programming platforms or tools

GAMING & GADGETS:
- Major gaming console launches and updates
- Significant phone launches (iPhone, Pixel, Samsung flagship)
- GPU launches that affect developers/gamers
- Major game releases with tech significance
- VR/AR hardware and software

DESIGN & UX:
- Design tool updates (Figma, Sketch, Adobe)
- Design system releases from major companies
- UX research findings
- New design trends backed by data

QA & TESTING:
- Testing framework releases
- CI/CD platform updates
- Quality engineering practices from major companies

RESEARCH & PAPERS:
- Significant papers from Google, Meta, OpenAI, DeepMind, Microsoft Research
- Academic breakthroughs in CS/AI/ML
- Research that could change how we build software

COOL TECH:
- Humanoid robots, autonomous vehicles, drones
- Quantum computing milestones
- Space tech with software/AI angle
- Any technology that makes you go "wow, the future is here"

CAREER & CULTURE:
- Remote work trends and policies
- Developer salary reports and surveys
- Tech hiring/firing trends
- Interesting tech career stories and journeys

WHAT WE STILL REJECT:
- Pure politics with zero tech angle
- Sports news (unless esports/tech)
- Entertainment/celebrity news (unless tech figure)
- Health/medical news (unless health-tech)
- Tutorials, how-to guides, listicles ("10 best ways to...")
- Personal blog posts with no news value
- Press releases with no substance (just a landing page)
- Anything older than 48 hours
- Low-effort Reddit self-posts (questions, rants without news value)

QUALITY SCORING (this is what matters most):
- 9-10: Breaking news, everyone in tech is talking about this RIGHT NOW
- 7-8: Important for a specific tech segment, well-written, substantial
- 5-6: Mildly interesting but not essential — REJECT (we only want 7+)
- 1-4: Low quality, irrelevant, or poorly written — REJECT

Quality means: Is it well-written? Does it have substance? Would a busy tech professional be glad they spent 60 seconds reading this? If yes → 7+. If "meh" → reject.

TAG RULES:
- Pick 1-3 tags from: ai-ml, python, javascript, node-js, frontend, backend, devops, cloud, cybersecurity, databases, open-source, career-jobs, competitive-programming, gaming-gadgets, design-ux, qa-testing, research-papers, cool-tech, tech-personalities, startups-funding, indian-tech
- Be precise and pick the most relevant tags
- An Indian startup funding round = ["startups-funding", "indian-tech"]
- A Codeforces contest = ["competitive-programming"]
- Elon Musk statement about AI = ["tech-personalities", "ai-ml"]
- A new Figma feature = ["design-ux"]

CRITICAL: Quality over quantity. Reject anything below 7. But don't reject an entire CATEGORY — reject bad articles within any category.`;

// Whitelist of enum values Prisma client accepts
const SAFE_ARTICLE_TYPES = new Set([
  "PRODUCT_LAUNCH", "BUSINESS", "SECURITY", "STATEMENT", "DEEP_TECH",
  "COMPETITIVE_PROGRAMMING", "GAMING_GADGETS", "DESIGN", "RESEARCH",
  "COOL_TECH", "CAREER_CULTURE",
]);

const TYPE_ALIASES: Record<string, string> = {
  "TECH_PERSONALITIES": "STATEMENT",
  "AI & MACHINE LEARNING": "DEEP_TECH",
  "AI_ML": "DEEP_TECH",
  "CAREER": "CAREER_CULTURE",
  "GAMING": "GAMING_GADGETS",
  "GADGETS": "GAMING_GADGETS",
  "UX": "DESIGN",
  "OPEN_SOURCE": "DEEP_TECH",
  "FUNDING": "BUSINESS",
  "ACQUISITION": "BUSINESS",
  "LAYOFF": "BUSINESS",
  "REGULATION": "STATEMENT",
};

function safeArticleType(raw: string): string {
  const upper = raw.toUpperCase().trim();
  if (SAFE_ARTICLE_TYPES.has(upper)) return upper;
  if (TYPE_ALIASES[upper]) return TYPE_ALIASES[upper];
  console.log(`[classify] Unknown type '${raw}', mapped to DEEP_TECH`);
  return "DEEP_TECH";
}

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

  if (!hasBudget()) {
    console.warn(`[Stage 2] Daily token budget exhausted (${getBudgetStatus()}). Will resume tomorrow.`);
    return { passed: 0, rejected: 0 };
  }

  const allArticles = await prisma.pipelineArticle.findMany({
    where: { stage: "FETCHED" },
    orderBy: { createdAt: "asc" },
    take: 200,
  });

  if (allArticles.length === 0) {
    console.log("[Stage 2] No articles to classify");
    return { passed: 0, rejected: 0 };
  }

  // Source-interleaving: round-robin from each source for natural diversity
  const bySource = new Map<string, typeof allArticles>();
  for (const a of allArticles) {
    const group = bySource.get(a.source) ?? [];
    group.push(a);
    bySource.set(a.source, group);
  }

  const sourceCounts = Array.from(bySource.entries()).map(([s, g]) => `${s}(${g.length})`);
  console.log(`[classify] Sources: ${sourceCounts.join(", ")}`);

  // Round-robin: pick one from each source in turn
  const interleaved: typeof allArticles = [];
  const sourceQueues = Array.from(bySource.values());
  const indices = new Array(sourceQueues.length).fill(0);

  while (interleaved.length < MAX_ARTICLES_PER_RUN) {
    let added = false;
    for (let i = 0; i < sourceQueues.length; i++) {
      if (indices[i] < sourceQueues[i].length) {
        interleaved.push(sourceQueues[i][indices[i]]);
        indices[i]++;
        added = true;
        if (interleaved.length >= MAX_ARTICLES_PER_RUN) break;
      }
    }
    if (!added) break; // All sources exhausted
  }

  const batch = interleaved;
  console.log(`[classify] Batch: ${batch.length} articles from ${bySource.size} sources`);

  let passed = 0;
  let rejected = 0;

  for (const article of batch) {
    try {
      const userPrompt = `Title: ${article.rawTitle}\nDescription: ${article.rawDescription ?? "N/A"}\nSource: ${article.source}`;

      const result = await callModel("classify", CLASSIFY_SYSTEM_PROMPT, userPrompt);

      if (!result) {
        console.warn(`[classify] No response for: ${article.rawTitle}`);
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "REJECTED",
            classificationReason: "No response from classification model",
            classifiedAt: new Date(),
          },
        });
        rejected++;
        continue;
      }

      const parsed = parseJSON<ClassifyResult>(result.response);

      if (!parsed) {
        console.warn(`[classify] Unparseable response for: ${article.rawTitle}`);
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "REJECTED",
            classificationReason: "Unparseable classification response",
            classifiedAt: new Date(),
            classifiedByModel: result.model,
          },
        });
        rejected++;
        continue;
      }

      if (!parsed.isNews || parsed.qualityScore < 7) {
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
        // Validate articleType BEFORE passing to Prisma (client-side validation)
        const articleType = safeArticleType(parsed.articleType);
        if (articleType !== parsed.articleType) {
          console.warn(`[classify] Unknown type '${parsed.articleType}', mapped to DEEP_TECH`);
        }

        try {
          await prisma.pipelineArticle.update({
            where: { id: article.id },
            data: {
              stage: "CLASSIFIED",
              articleType: articleType as any,
              qualityScore: parsed.qualityScore,
              relevanceScore: parsed.relevanceScore,
              trendingScore: parsed.trendingScore,
              classificationReason: parsed.reasoning,
              classifiedAt: new Date(),
              classifiedByModel: result.model,
              suggestedTags: JSON.stringify(parsed.suggestedTags ?? []),
            },
          });
        } catch (updateErr: any) {
          // If Prisma rejects the enum value for ANY reason, retry with DEEP_TECH
          console.warn(`[classify] Update failed for type '${articleType}': ${updateErr.message}. Retrying with DEEP_TECH`);
          await prisma.pipelineArticle.update({
            where: { id: article.id },
            data: {
              stage: "CLASSIFIED",
              articleType: "DEEP_TECH",
              qualityScore: parsed.qualityScore,
              relevanceScore: parsed.relevanceScore,
              trendingScore: parsed.trendingScore,
              classificationReason: parsed.reasoning,
              classifiedAt: new Date(),
              classifiedByModel: result.model,
              suggestedTags: JSON.stringify(parsed.suggestedTags ?? []),
            },
          });
        }
        passed++;
        console.log(
          `[classify] PASSED: ${article.rawTitle} → ${articleType} (quality=${parsed.qualityScore})`
        );
      }
    } catch (err: any) {
      console.error(`[classify] Error processing ${article.rawTitle}: ${err.message}`);
      // Don't crash the stage — mark as rejected and continue
      try {
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "REJECTED",
            classificationReason: `Classification error: ${err.message}`,
            classifiedAt: new Date(),
          },
        });
      } catch {
        // Even the error handler failed — just log and move on
        console.error(`[classify] Could not update article ${article.id} after error`);
      }
      rejected++;
    }
  }

  console.log(`[Stage 2] Classified ${batch.length}: ${passed} passed, ${rejected} rejected`);
  return { passed, rejected };
}
