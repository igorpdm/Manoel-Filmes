import { Router } from "express";

interface TmdbDeps {
  apiKey: string;
  baseUrl: string;
  imageBase: string;
}

export function createTmdbRouter(deps: TmdbDeps): Router {
  const router = Router();

  router.get("/search-movie/:query", async (req, res) => {
    const query = req.params.query;

    if (!query) {
      res.status(400).json({ error: "Query não fornecida" });
      return;
    }
    if (!deps.apiKey) {
      res.status(500).json({ error: "TMDB API Key não configurada" });
      return;
    }

    try {
      const searchUrl = `${deps.baseUrl}/search/multi?api_key=${deps.apiKey}&query=${encodeURIComponent(query)}&language=pt-BR`;
      const searchRes = await fetch(searchUrl);
      const searchData = await searchRes.json() as any;

      if (!searchData.results) {
        res.status(404).json({ error: "Filme/Série não encontrado" });
        return;
      }

      const candidates = searchData.results.filter((r: any) => r.media_type === "movie" || r.media_type === "tv");

      if (candidates.length === 0) {
        res.status(404).json({ error: "Nenhum filme ou série encontrado" });
        return;
      }

      const bestMatch = candidates[0];
      const mediaId = bestMatch.id;
      const mediaType = bestMatch.media_type;

      let detailsUrl;
      if (mediaType === "movie") {
        detailsUrl = `${deps.baseUrl}/movie/${mediaId}?api_key=${deps.apiKey}&language=pt-BR`;
      } else {
        detailsUrl = `${deps.baseUrl}/tv/${mediaId}?api_key=${deps.apiKey}&language=pt-BR`;
      }

      const detailsRes = await fetch(detailsUrl);
      const details = await detailsRes.json() as any;

      let seasons: any[] = [];

      if (mediaType === "tv" && details.seasons) {
        const seasonPromises = details.seasons
          .filter((s: any) => s.season_number > 0)
          .map(async (season: any) => {
            const seasonUrl = `${deps.baseUrl}/tv/${mediaId}/season/${season.season_number}?api_key=${deps.apiKey}&language=pt-BR`;
            const seasonRes = await fetch(seasonUrl);
            const seasonData = await seasonRes.json() as any;

            return {
              id: seasonData.id,
              seasonNumber: seasonData.season_number,
              name: seasonData.name,
              episodeCount: seasonData.episodes?.length || 0,
              posterPath: seasonData.poster_path ? `${deps.imageBase}/w300${seasonData.poster_path}` : null,
              episodes: (seasonData.episodes || []).map((ep: any) => ({
                id: ep.id,
                episodeNumber: ep.episode_number,
                name: ep.name,
                overview: ep.overview || "",
                stillPath: ep.still_path ? `${deps.imageBase}/w300${ep.still_path}` : null,
                airDate: ep.air_date || "",
                runtime: ep.runtime || null
              }))
            };
          });

        seasons = await Promise.all(seasonPromises);
      }

      const movieInfo = {
        id: details.id,
        title: details.title || details.name || bestMatch.title || bestMatch.name,
        posterUrl: details.poster_path ? `${deps.imageBase}/w500${details.poster_path}` : null,
        backdropUrl: details.backdrop_path ? `${deps.imageBase}/w1280${details.backdrop_path}` : null,
        overview: details.overview || "",
        releaseDate: details.release_date || details.first_air_date || "",
        voteAverage: details.vote_average || 0,
        genres: (details.genres || []).map((g: { name: string }) => g.name),
        mediaType: mediaType,
        ...(mediaType === "tv" && { seasons })
      };

      res.json(movieInfo);
    } catch (e) {
      console.error("[TMDB] Error:", e);
      res.status(500).json({ error: "Erro ao buscar conteúdo" });
    }
  });

  return router;
}
