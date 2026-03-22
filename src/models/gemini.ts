import { GoogleGenerativeAI } from "@google/generative-ai";
import { trackTokens } from "../utils/tokenBudget";

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY ?? "");

export async function callGemini(
  systemPrompt: string,
  userPrompt: string,
  model: string
): Promise<string | null> {
  try {
    const genModel = genAI.getGenerativeModel({
      model,
      systemInstruction: systemPrompt,
    });

    const result = await genModel.generateContent(userPrompt);
    const output = result.response.text() ?? null;
    if (output) {
      trackTokens(Math.ceil((systemPrompt.length + userPrompt.length + output.length) / 4));
    }
    return output;
  } catch (err: any) {
    console.error(`[Gemini/${model}] Error:`, err.message);
    throw err;
  }
}
