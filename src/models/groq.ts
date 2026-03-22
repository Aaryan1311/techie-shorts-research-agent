import Groq from "groq-sdk";
import { trackTokens } from "../utils/tokenBudget";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Global rate-limit flag: when true, all subsequent calls should be skipped
let _rateLimited = false;

export function isRateLimited(): boolean {
  return _rateLimited;
}

export function setRateLimited(value: boolean): void {
  _rateLimited = value;
}

function estimateTokens(systemPrompt: string, userPrompt: string, output: string): number {
  return Math.ceil((systemPrompt.length + userPrompt.length + output.length) / 4);
}

export async function callGroq(
  systemPrompt: string,
  userPrompt: string,
  model: string
): Promise<string | null> {
  if (_rateLimited) {
    console.warn(`[Groq/${model}] Skipping — rate limited for this run`);
    return null;
  }

  try {
    const response = await groq.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    });

    const output = response.choices[0]?.message?.content ?? null;
    if (output) {
      trackTokens(estimateTokens(systemPrompt, userPrompt, output));
    }
    return output;
  } catch (err: any) {
    // Handle 429 rate limit
    if (err.status === 429 || err.statusCode === 429) {
      const retryAfter = err.headers?.["retry-after"];
      const waitSec = retryAfter ? parseInt(retryAfter, 10) : 60;
      console.warn(`[Groq/${model}] Rate limited (429). Retry-after: ${waitSec}s`);

      if (waitSec <= 120) {
        console.log(`[Groq/${model}] Waiting ${waitSec}s before retry...`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));

        try {
          const retryResponse = await groq.chat.completions.create({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            temperature: 0.3,
            max_tokens: 4096,
          });
          const output = retryResponse.choices[0]?.message?.content ?? null;
          if (output) {
            trackTokens(estimateTokens(systemPrompt, userPrompt, output));
          }
          return output;
        } catch (retryErr: any) {
          console.error(`[Groq/${model}] Retry also failed. Marking rate-limited for this run.`);
          _rateLimited = true;
          throw retryErr;
        }
      } else {
        console.error(`[Groq/${model}] Wait too long (${waitSec}s). Marking rate-limited for this run.`);
        _rateLimited = true;
        throw err;
      }
    }

    console.error(`[Groq/${model}] Error:`, err.message);
    throw err;
  }
}

export function parseJSON<T = any>(raw: string): T | null {
  try {
    let cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "");

    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1) return null;

    cleaned = cleaned.slice(firstBrace, lastBrace + 1);

    try {
      return JSON.parse(cleaned);
    } catch {
      cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
      return JSON.parse(cleaned);
    }
  } catch {
    console.error("[parseJSON] Failed to parse:", raw.slice(0, 200));
    return null;
  }
}
