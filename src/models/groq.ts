import Groq from "groq-sdk";
import { trackTokens } from "../utils/tokenBudget";

// Load all API keys from env
const apiKeys: string[] = [];
if (process.env.GROQ_API_KEY) apiKeys.push(process.env.GROQ_API_KEY);
if (process.env.GROQ_API_KEY_1) apiKeys.push(process.env.GROQ_API_KEY_1);
if (process.env.GROQ_API_KEY_2) apiKeys.push(process.env.GROQ_API_KEY_2);
if (process.env.GROQ_API_KEY_3) apiKeys.push(process.env.GROQ_API_KEY_3);
const uniqueKeys = [...new Set(apiKeys)].filter(Boolean);

if (uniqueKeys.length === 0) {
  console.error("[Groq] No API keys found. Set GROQ_API_KEY or GROQ_API_KEY_1/2/3");
}

console.log(`[Groq] ${uniqueKeys.length} API key(s) loaded`);

let currentKeyIndex = 0;
const clients: Groq[] = uniqueKeys.map((key) => new Groq({ apiKey: key }));

function rotateKey(triedKeys: Set<number>): boolean {
  const nextIndex = (currentKeyIndex + 1) % uniqueKeys.length;
  if (triedKeys.has(nextIndex)) return false; // all keys tried
  currentKeyIndex = nextIndex;
  console.log(`[Groq] Rotating to key ${currentKeyIndex + 1}/${uniqueKeys.length}`);
  return true;
}

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
  model: string,
  triedKeys: Set<number> = new Set()
): Promise<string | null> {
  if (_rateLimited) {
    console.warn(`[Groq/${model}] Skipping — all keys rate limited for this run`);
    return null;
  }

  if (clients.length === 0) {
    console.error("[Groq] No API keys available");
    return null;
  }

  triedKeys.add(currentKeyIndex);

  try {
    const client = clients[currentKeyIndex];
    const response = await client.chat.completions.create({
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
    if (err.status === 429 || err.statusCode === 429) {
      console.log(`[Groq] Key ${currentKeyIndex + 1} rate limited (429)`);

      // Try rotating to next key
      const rotated = rotateKey(triedKeys);
      if (rotated) {
        return callGroq(systemPrompt, userPrompt, model, triedKeys);
      }

      // All keys exhausted
      console.error(`[Groq] All ${uniqueKeys.length} key(s) exhausted. Marking rate-limited for this run.`);
      _rateLimited = true;
      throw err;
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
