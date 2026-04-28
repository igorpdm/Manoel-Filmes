import { TMDB_API_KEY, TMDB_BASE_URL } from "../../config";
import { logger } from "../../shared/logger";
import { buildTmdbImageUrl } from "../../shared/tmdb-image";

const TMDB_TIMEOUT_MS = 10000;

async function fetchTmdbJson(path: string, params: Record<string, string | number | undefined>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS);
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }

  try {
    const response = await fetch(`${TMDB_BASE_URL}${path}?${searchParams.toString()}`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`TMDB respondeu ${response.status}`);
    }

    return response.json() as Promise<any>;
  } finally {
    clearTimeout(timeout);
  }
}

export const searchMovieTmdb = async (title: string) => {
  try {
    const searchData = await fetchTmdbJson("/search/multi", {
      api_key: TMDB_API_KEY,
      query: title,
      language: "pt-BR",
    });

    const results = searchData?.results || [];
    const filtered = results.filter(
      (r: any) => r.media_type === "movie" || r.media_type === "tv"
    );

    if (!filtered.length) {
      return null;
    }

    const item = filtered[0];
    const isMovie = item.media_type === "movie";
    const endpoint = isMovie ? "movie" : "tv";

    const details = await fetchTmdbJson(`/${endpoint}/${item.id}`, {
      api_key: TMDB_API_KEY,
      language: "pt-BR",
    });
    const genres = details?.genres?.map((g: { name: string }) => g.name) || [];
    const posterPath = item.poster_path || details.poster_path;

    let seasons: any[] = [];
    if (!isMovie && details.seasons) {
      const seasonPromises = details.seasons
        .filter((s: any) => s.season_number > 0)
        .map(async (season: any) => {
          try {
            const seasonData = await fetchTmdbJson(`/tv/${item.id}/season/${season.season_number}`, {
              api_key: TMDB_API_KEY,
              language: "pt-BR",
            });
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
                stillPath: buildTmdbImageUrl(ep.still_path),
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
      poster_url: buildTmdbImageUrl(posterPath),
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
