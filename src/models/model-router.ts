import { MODEL_CONFIG, RATE_LIMITS } from "../config";
import { callGroq } from "./groq";
import { callGemini } from "./gemini";

type Stage = keyof typeof MODEL_CONFIG;

interface ModelResult {
  response: string;
  model: string;
}

let lastGroqCall = 0;
let lastGeminiCall = 0;

async function waitForRateLimit(provider: "groq" | "gemini"): Promise<void> {
  const now = Date.now();
  const lastCall = provider === "groq" ? lastGroqCall : lastGeminiCall;
  const delay = RATE_LIMITS[provider];
  const elapsed = now - lastCall;

  if (elapsed < delay) {
    await new Promise((resolve) => setTimeout(resolve, delay - elapsed));
  }

  if (provider === "groq") lastGroqCall = Date.now();
  else lastGeminiCall = Date.now();
}

async function callProvider(
  provider: "groq" | "gemini",
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string | null> {
  await waitForRateLimit(provider);

  if (provider === "groq") {
    return callGroq(systemPrompt, userPrompt, model);
  } else {
    return callGemini(systemPrompt, userPrompt, model);
  }
}

export async function callModel(
  stage: Stage,
  systemPrompt: string,
  userPrompt: string
): Promise<ModelResult | null> {
  const config = MODEL_CONFIG[stage];

  // Try primary model
  try {
    console.log(`[${stage}] Trying primary: ${config.primary.model}`);
    const response = await callProvider(
      config.primary.provider,
      config.primary.model,
      systemPrompt,
      userPrompt
    );
    if (response) {
      return { response, model: config.primary.model };
    }
  } catch (err: any) {
    console.warn(
      `[${stage}] Primary model failed: ${err.message}`
    );
  }

  // Try fallback model
  try {
    console.log(`[${stage}] Trying fallback: ${config.fallback.model}`);
    const response = await callProvider(
      config.fallback.provider,
      config.fallback.model,
      systemPrompt,
      userPrompt
    );
    if (response) {
      return { response, model: config.fallback.model };
    }
  } catch (err: any) {
    console.warn(
      `[${stage}] Fallback model failed: ${err.message}`
    );
  }

  console.error(`[${stage}] Both models failed`);
  return null;
}
