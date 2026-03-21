import { ArticleType } from "@prisma/client";
import prisma from "../db";
import { callModel } from "../models/model-router";
import { parseJSON } from "../models/groq";
import { MAX_ARTICLES_PER_RUN } from "../config";

const BASE_SYSTEM_PROMPT = `You are a tech journalist writing for Techie Shorts, a news app for tech professionals.

WRITING RULES:
- Language must be so simple that someone without ANY tech background can understand
- No jargon without explanation. "API" → "a way for apps to talk to each other". "Kubernetes" → "a system that manages cloud servers"
- Headline must be catchy and hook-driven. Not "Company X releases Product Y" but "Company X just solved a problem every developer has been complaining about"
- No fluff words: "exciting", "revolutionary", "game-changing", "groundbreaking"
- Lead with WHAT happened, not background
- Include specific numbers, names, versions when available

Return ONLY valid JSON with these fields:
{
  "headline": "catchy hook-driven headline",
  "summary": "Write a summary that is EXACTLY between 60 and 80 words. Count carefully. This is NOT a headline — it's a full paragraph that tells the complete story in miniature. It should answer: What happened? Who is involved? Why does it matter? A 20-word summary is TOO SHORT and will be rejected. A 100-word summary is TOO LONG. Aim for exactly 70 words.",
  "detailContent": "300-400 word detailed article",
  "whatsNext": {
    "industryImpact": "150-200 words on how this changes the tech world",
    "personalImpact": "100-150 words on what YOU should do differently",
    "buildIdeas": [...] or null
  },
  "tags": ["tag-slug-1", "tag-slug-2"]
}`;

const TYPE_PROMPTS: Record<string, string> = {
  PRODUCT_LAUNCH: `This is a product/tool launch. The detailed article should cover: what is it, what problem does it solve, who made it, how is it different from alternatives, pricing/availability. "whatsNext.buildIdeas" should be an array of 3 objects: [{"name": "Project Name", "difficulty": "Easy/Medium/Hard", "description": "2-3 sentences"}] sorted by difficulty.`,

  BUSINESS: `This is business news. The detailed article should cover: which company, what happened, how much money (if funding), who's affected (if layoff), why it matters for the industry. "whatsNext.buildIdeas" should be null — business news doesn't have build ideas.`,

  SECURITY: `This is security news. The detailed article should cover: what vulnerability/breach, who's affected, severity, what to do about it, timeline. "whatsNext.buildIdeas" should be an array of 2-3 security tool ideas developers can build.`,

  STATEMENT: `This is about a tech leader's statement or opinion. The detailed article should cover: who said it, exact quote or paraphrase, context, why it matters, any responses from others. "whatsNext.buildIdeas" should be null.`,

  DEEP_TECH: `This is a technical deep-dive (research paper, engineering blog). The detailed article should explain the concept in simple terms — imagine explaining to a smart 15-year-old. Use analogies. "whatsNext.buildIdeas" should be an array of 2-3 experiment ideas.`,

  COMPETITIVE_PROGRAMMING: `This is competitive programming news. The detailed article should cover: which contest/platform, results or changes, notable participants, impact on the CP community. "whatsNext.buildIdeas" should include practice resources or tools competitive programmers can build.`,

  GAMING_GADGETS: `This is gaming/gadget news. The detailed article should cover: what was announced/launched, specs that matter, pricing, availability, how it compares to competitors. "whatsNext.buildIdeas" should be null unless there's a clear developer angle (e.g., new SDK, modding tools).`,

  DESIGN: `This is design/UX news. The detailed article should cover: what tool/update/finding, how it changes the design workflow, who benefits most, what's different from before. "whatsNext.buildIdeas" should include design tool plugins or resources designers can create.`,

  RESEARCH: `This is a research paper or technical finding. The detailed article should explain the concept in the SIMPLEST possible terms — imagine explaining to a smart 15-year-old. Use analogies from everyday life. Cover: what was discovered, why it matters, who did the research, what could this lead to. "whatsNext.buildIdeas" should include experiment ideas researchers or developers can try.`,

  COOL_TECH: `This is cool/futuristic tech news. The detailed article should capture the WOW factor — what happened, why it's impressive, how close we are to this being normal. Make the reader excited about the future. "whatsNext.buildIdeas" can include fun project ideas inspired by this tech.`,

  CAREER_CULTURE: `This is career/culture news. The detailed article should cover: what changed, which companies/regions are affected, data and numbers if available, what tech professionals should consider. "whatsNext.buildIdeas" should be null. Instead "whatsNext.personalImpact" should be extra detailed with actionable career advice.`,
};

interface BuildIdea {
  name: string;
  difficulty: string;
  description: string;
}

interface GenerateResult {
  headline: string;
  summary: string;
  detailContent: string;
  whatsNext: {
    industryImpact: string;
    personalImpact: string;
    buildIdeas: BuildIdea[] | null;
  };
  tags: string[];
}

function ensureString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatBuildIdeas(ideas: BuildIdea[] | null): string | null {
  if (!ideas || !Array.isArray(ideas) || ideas.length === 0) return null;

  const difficultyOrder: Record<string, number> = { Easy: 0, Medium: 1, Hard: 2 };
  const sorted = [...ideas].sort(
    (a, b) => (difficultyOrder[a.difficulty] ?? 1) - (difficultyOrder[b.difficulty] ?? 1)
  );

  return sorted
    .map((idea, i) => `${i + 1}. ${idea.name} [${idea.difficulty}] - ${idea.description}`)
    .join("\n\n");
}

function formatFutureImpact(whatsNext: GenerateResult["whatsNext"]): string | null {
  const parts: string[] = [];

  if (whatsNext.industryImpact) {
    parts.push(`**Industry Impact**\n\n${whatsNext.industryImpact}`);
  }
  if (whatsNext.personalImpact) {
    parts.push(`**What This Means For You**\n\n${whatsNext.personalImpact}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

export async function runGenerateStage(): Promise<number> {
  console.log("[Stage 6] Generating content...");

  const articles = await prisma.pipelineArticle.findMany({
    where: { stage: "VERIFIED" },
    orderBy: { verifiedAt: "asc" },
    take: MAX_ARTICLES_PER_RUN,
  });

  if (articles.length === 0) {
    console.log("[Stage 6] No articles to generate");
    return 0;
  }

  let generated = 0;

  for (const article of articles) {
    try {
      const articleType = article.articleType ?? "DEEP_TECH";
      const typePrompt = TYPE_PROMPTS[articleType] ?? TYPE_PROMPTS.DEEP_TECH;

      const systemPrompt = `${BASE_SYSTEM_PROMPT}\n\n${typePrompt}`;

      // Build user prompt with full article text when available
      let userPrompt = `Source article title: ${article.rawTitle}\nSource: ${article.source}\nSource description: ${article.rawDescription ?? "N/A"}\nArticle Type: ${articleType}`;

      if (article.fullArticleText && article.sourceReadSuccess) {
        const truncatedText = article.fullArticleText.split(/\s+/).slice(0, 1500).join(" ");
        userPrompt += `\n\nFull source article (use this as the primary source of facts):\n${truncatedText}\n\nIMPORTANT: Base your detailed article on the FACTS in the source article above. Do NOT make up facts, quotes, numbers, or details that aren't in the source. If the source doesn't provide enough detail, say so honestly rather than fabricating.`;
      }

      const result = await callModel("generate", systemPrompt, userPrompt);

      if (!result) {
        console.warn(`[generate] No response for: ${article.rawTitle}`);
        await prisma.pipelineArticle.update({
          where: { id: article.id },
          data: {
            stage: "FAILED",
            failedAt: new Date(),
            failureReason: "Generation model returned no response",
            retryCount: { increment: 1 },
          },
        });
        continue;
      }

      let parsed = parseJSON<GenerateResult>(result.response);

      if (!parsed || !parsed.headline || !parsed.summary) {
        // Retry with simplified prompt
        console.warn(`[generate] Unparseable response, retrying with simplified prompt: ${article.rawTitle}`);
        const simplePrompt = `Write a news headline and 60-80 word summary for this article. Return ONLY valid JSON:\n{"headline": "...", "summary": "...", "detailContent": null, "whatsNext": null, "tags": []}\n\nTitle: ${article.rawTitle}\nDescription: ${article.rawDescription ?? "N/A"}`;
        const retryResult = await callModel("generate", "You are a tech news writer. Return only valid JSON.", simplePrompt);

        if (retryResult) {
          parsed = parseJSON<GenerateResult>(retryResult.response);
        }

        if (!parsed || !parsed.headline || !parsed.summary) {
          console.warn(`[generate] Retry also failed for: ${article.rawTitle}`);
          await prisma.pipelineArticle.update({
            where: { id: article.id },
            data: {
              stage: "FAILED",
              failedAt: new Date(),
              failureReason: "Failed to parse generation JSON after retry",
              retryCount: { increment: 1 },
            },
          });
          continue;
        }
      }

      // Enforce minimum summary length — expand if too short
      let finalSummary = ensureString(parsed.summary) ?? "";
      const summaryWordCount = finalSummary.split(/\s+/).length;
      if (summaryWordCount < 50 && finalSummary.length > 0) {
        console.warn(`[generate] Summary too short (${summaryWordCount} words), expanding: ${article.rawTitle}`);
        try {
          const expandPrompt = `The following summary is too short at ${summaryWordCount} words. Expand it to EXACTLY 70 words while keeping the same meaning. Add more context, details, and specifics. Do NOT change the tone or key facts.\n\nCurrent summary: ${finalSummary}\n\nReturn ONLY the expanded summary text, nothing else.`;
          const expandResult = await callModel("generate", "You are a tech news editor. Return only the expanded summary text.", expandPrompt);
          if (expandResult?.response) {
            const expanded = expandResult.response.replace(/```/g, "").trim();
            if (expanded.split(/\s+/).length >= 50) {
              finalSummary = expanded;
              console.log(`[generate] Summary expanded to ${expanded.split(/\s+/).length} words`);
            }
          }
        } catch {
          // Keep original if expansion fails
        }
      }

      const futureImpact = parsed.whatsNext
        ? formatFutureImpact(parsed.whatsNext)
        : null;

      const buildOnThis = parsed.whatsNext?.buildIdeas
        ? formatBuildIdeas(parsed.whatsNext.buildIdeas)
        : null;

      await prisma.pipelineArticle.update({
        where: { id: article.id },
        data: {
          stage: "CONTENT_GENERATED",
          generatedHeadline: ensureString(parsed.headline),
          generatedSummary: finalSummary,
          generatedDetail: ensureString(parsed.detailContent),
          generatedWhatsNext: futureImpact,
          generatedBuildOnThis: buildOnThis,
          generatedAt: new Date(),
          generatedByModel: result.model,
          suggestedTags: JSON.stringify(parsed.tags ?? []),
        },
      });

      generated++;
      console.log(`[generate] Generated: ${parsed.headline}`);
    } catch (err: any) {
      console.error(`[generate] Error processing ${article.rawTitle}: ${err.message}`);
      await prisma.pipelineArticle.update({
        where: { id: article.id },
        data: {
          stage: "FAILED",
          failedAt: new Date(),
          failureReason: `Generation error: ${err.message}`,
          retryCount: { increment: 1 },
        },
      });
    }
  }

  console.log(`[Stage 6] Generated content for ${generated}/${articles.length} articles`);
  return generated;
}
