import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export async function callGroq(
  systemPrompt: string,
  userPrompt: string,
  model: string
): Promise<string | null> {
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

    return response.choices[0]?.message?.content ?? null;
  } catch (err: any) {
    console.error(`[Groq/${model}] Error:`, err.message);
    throw err;
  }
}

export function parseJSON<T = any>(raw: string): T | null {
  try {
    // Strip markdown code fences
    let cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "");

    // Find the first { and last }
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1) return null;

    cleaned = cleaned.slice(firstBrace, lastBrace + 1);

    // Try direct parse
    try {
      return JSON.parse(cleaned);
    } catch {
      // Fix trailing commas
      cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
      return JSON.parse(cleaned);
    }
  } catch {
    console.error("[parseJSON] Failed to parse:", raw.slice(0, 200));
    return null;
  }
}
