import yts from "yt-search";
import { logger } from "../../shared/logger";

export const searchTrailerYoutube = async (movieTitle: string, year = "") => {
  const query = `trailer ${movieTitle} ${year} official`.trim();
  try {
    const result = await yts(query);
    const video = result?.videos?.[0];
    return video?.url || null;
  } catch (error) {
    logger.error("YoutubeService", `Falha ao buscar trailer: ${query}`, error);
    return null;
  }
};
