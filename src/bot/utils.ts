import { ButtonStyle } from "discord.js";

export const toMovieId = (movieKey: string) => {
  let hash = 5381;
  for (let i = 0; i < movieKey.length; i += 1) {
    hash = (hash * 33) ^ movieKey.charCodeAt(i);
  }
  return String(Math.abs(hash) % 100000);
};

export const getNotaEmoji = (nota: number) => {
  if (nota <= 3) return "💔";
  if (nota <= 5) return "😐";
  if (nota <= 7) return "👍";
  if (nota <= 9) return "🔥";
  return "🏆";
};

export const getButtonStyle = (nota: number) => {
  if (nota <= 3) return ButtonStyle.Danger;
  if (nota <= 6) return ButtonStyle.Secondary;
  if (nota <= 8) return ButtonStyle.Primary;
  return ButtonStyle.Success;
};

export const formatWatchDate = (value?: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("pt-BR");
};