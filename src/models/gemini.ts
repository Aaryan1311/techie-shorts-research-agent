import { GoogleGenerativeAI } from "@google/generative-ai";

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
    return result.response.text() ?? null;
  } catch (err: any) {
    console.error(`[Gemini/${model}] Error:`, err.message);
    throw err;
  }
}
