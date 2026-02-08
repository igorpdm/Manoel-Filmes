import axios from "axios";
import { TMDB_API_KEY, TMDB_BASE_URL, TMDB_IMAGE_BASE } from "../../config";
import { logger } from "../../shared/logger";

const tmdbApi = axios.create({
  timeout: 10000,
});

export const searchMovieTmdb = async (title: string) => {
  try {
    const searchResponse = await tmdbApi.get(`${TMDB_BASE_URL}/search/multi`, {
      params: {
        api_key: TMDB_API_KEY,
        query: title,
        language: "pt-BR",
      },
    });

    const results = searchResponse.data?.results || [];
    const filtered = results.filter(
      (r: any) => r.media_type === "movie" || r.media_type === "tv"
    );

    if (!filtered.length) {
      return null;
    }

    const item = filtered[0];
    const isMovie = item.media_type === "movie";
    const endpoint = isMovie ? "movie" : "tv";

    const detailResponse = await tmdbApi.get(`${TMDB_BASE_URL}/${endpoint}/${item.id}`, {
      params: {
        api_key: TMDB_API_KEY,
        language: "pt-BR",
      },
    });

    const details = detailResponse.data;
    const genres = details?.genres?.map((g: { name: string }) => g.name) || [];
    const posterPath = item.poster_path || details.poster_path;

    let seasons: any[] = [];
    if (!isMovie && details.seasons) {
      const seasonPromises = details.seasons
        .filter((s: any) => s.season_number > 0)
        .map(async (season: any) => {
          try {
            const seasonRes = await tmdbApi.get(
              `${TMDB_BASE_URL}/tv/${item.id}/season/${season.season_number}`,
              {
                params: {
                  api_key: TMDB_API_KEY,
                  language: "pt-BR",
                },
              }
            );

            const seasonData = seasonRes.data;
            return {
              id: seasonData.id,
              seasonNumber: seasonData.season_number,
              name: seasonData.name,
              episodeCount: seasonData.episodes?.length || 0,
              episodes: (seasonData.episodes || []).map((ep: any) => ({
                id: ep.id,
                episodeNumber: ep.episode_number,
                name: ep.name,
                overview: ep.overview || "",
                stillPath: ep.still_path
                  ? `${TMDB_IMAGE_BASE}${ep.still_path}`
                  : null,
                airDate: ep.air_date || "",
                runtime: ep.runtime || null,
              })),
            };
          } catch {
            logger.warn("TmdbService", `Falha ao carregar temporada ${season.season_number} de ${item.id}`);
            return null;
          }
        });

      seasons = (await Promise.all(seasonPromises)).filter(Boolean);
    }

    return {
      id: item.id,
      title: isMovie ? item.title || title : item.name || title,
      poster_url: posterPath ? `${TMDB_IMAGE_BASE}${posterPath}` : null,
      overview: item.overview || details.overview || "",
      release_date: isMovie
        ? item.release_date || ""
        : item.first_air_date || details.first_air_date || "",
      vote_average: item.vote_average || details.vote_average || 0,
      genres,
      media_type: item.media_type,
      seasons: seasons.length ? seasons : undefined,
    };
  } catch (error) {
    logger.error("TmdbService", `Falha ao buscar mídia: ${title}`, error);
    return null;
  }
};
