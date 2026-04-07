import axios from "axios";
import { TMDB_API_KEY, TMDB_BASE_URL } from "../../config";
import { logger } from "../../shared/logger";
import { searchMovieTmdb } from "./tmdb";

interface TmdbVideoResult {
  key: string;
  site: string;
  type: string;
  official?: boolean;
}

export const searchTrailerYoutube = async (movieTitle: string, year = "") => {
  try {
    const media = await searchMovieTmdb(`${movieTitle} ${year}`.trim());
    if (!media || !TMDB_API_KEY) {
      return null;
    }

    const endpoint = media.media_type === "movie" ? "movie" : "tv";
    const response = await axios.get(`${TMDB_BASE_URL}/${endpoint}/${media.id}/videos`, {
      params: {
        api_key: TMDB_API_KEY,
        language: "pt-BR",
      },
      timeout: 10000,
    });

    const videos = (response.data?.results || []) as TmdbVideoResult[];
    const youtubeVideos = videos.filter((video) => video.site === "YouTube");
    const bestMatch = youtubeVideos[0];

    return bestMatch ? `https://www.youtube.com/watch?v=${bestMatch.key}` : null;
  } catch (error) {
    logger.error("YoutubeService", `Falha ao buscar trailer: ${movieTitle}`, error);
    return null;
  }
};
