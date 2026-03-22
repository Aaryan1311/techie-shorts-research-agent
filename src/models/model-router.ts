import { MODEL_CONFIG, RATE_LIMITS } from "../config";
import { callGroq, isRateLimited } from "./groq";
import { callGemini } from "./gemini";

type Stage = keyof typeof MODEL_CONFIG;

interface ModelResult {
  response: string;
  model: string;
}

let lastGroqCall = 0;
let lastGeminiCall = 0;

// Daily LLM call tracker
let _llmCallCount = 0;
let _classifyCallCount = 0;
let _generateCallCount = 0;
let _lastResetDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

function checkAndResetDaily(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _lastResetDate) {
    console.log(`[model-router] New day (${today}). Resetting LLM call counters.`);
    _llmCallCount = 0;
    _classifyCallCount = 0;
    _generateCallCount = 0;
    _lastResetDate = today;
  }
}

export function getLLMCounts() {
  checkAndResetDaily();
  return {
    total: _llmCallCount,
    classify: _classifyCallCount,
    generate: _generateCallCount,
  };
}

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
  checkAndResetDaily();

  // Check rate-limit flag
  if (isRateLimited()) {
    console.warn(`[${stage}] Rate limited — will resume next run`);
    return null;
  }

  const config = MODEL_CONFIG[stage];

  // Try primary model
  try {
    const response = await callProvider(
      config.primary.provider,
      config.primary.model,
      systemPrompt,
      userPrompt
    );
    if (response) {
      _llmCallCount++;
      if (stage === "classify") _classifyCallCount++;
      if (stage === "generate") _generateCallCount++;
      return { response, model: config.primary.model };
    }
  } catch (err: any) {
    console.warn(`[${stage}] Primary model failed: ${err.message}`);
    if (isRateLimited()) {
      console.warn(`[${stage}] Rate limited — will resume next run`);
      return null;
    }
  }

  // Try fallback model
  try {
    const response = await callProvider(
      config.fallback.provider,
      config.fallback.model,
      systemPrompt,
      userPrompt
    );
    if (response) {
      _llmCallCount++;
      if (stage === "classify") _classifyCallCount++;
      if (stage === "generate") _generateCallCount++;
      return { response, model: config.fallback.model };
    }
  } catch (err: any) {
    console.warn(`[${stage}] Fallback model failed: ${err.message}`);
  }

  console.error(`[${stage}] Both models failed`);
  return null;
}
