import { GoogleGenerativeAI } from "@google/generative-ai";
import { GEMINI_API_KEY } from "../../config";

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || "");
const geminiModel = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

export const generateRecommendations = async (prompt: string) => {
  const response = await geminiModel.generateContent(prompt);
  return response.response.text().trim();
};