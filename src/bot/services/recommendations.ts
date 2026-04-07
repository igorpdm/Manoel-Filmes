import type { MovieWithRatings } from "../../database/types";
import { generateRecommendations } from "./gemini";
import { searchMovieTmdb } from "./tmdb";

interface RecommendationItem {
  titulo: string;
  motivo: string;
}

interface GenreInsight {
  genre: string;
  averageScore: number;
  ratingsCount: number;
  movieCount: number;
}

interface MovieInsight {
  title: string;
  averageScore: number;
  ratingsCount: number;
  genres: string[];
}

interface MemberInsight {
  userName: string;
  averageScore: number;
  ratingsCount: number;
  favoriteGenres: GenreInsight[];
  leastFavoriteGenres: GenreInsight[];
  favoriteMovies: MovieInsight[];
}

interface GroupProfile {
  totalMovies: number;
  totalRatings: number;
  topGenres: GenreInsight[];
  lowGenres: GenreInsight[];
  favoriteMovies: MovieInsight[];
  leastFavoriteMovies: MovieInsight[];
  polarizingMovies: MovieInsight[];
  members: MemberInsight[];
}

interface RawRecommendationResponse {
  recomendacoes?: RecommendationItem[];
}

interface RecommendationProgress {
  step: string;
  detail: string;
}

interface RecommendationOptions {
  onProgress?: (progress: RecommendationProgress) => Promise<void> | void;
}

const fallbackRecommendationMultiplier = 3;

const normalizeText = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

const splitGenres = (genres: string | null) =>
  (genres || "")
    .split(",")
    .map((genre) => genre.trim())
    .filter(Boolean);

const calculateAverage = (ratings: number[]) => {
  if (!ratings.length) {
    return 0;
  }

  return Math.round((ratings.reduce((total, rating) => total + rating, 0) / ratings.length) * 10) / 10;
};

const calculateStandardDeviation = (ratings: number[]) => {
  if (ratings.length < 2) {
    return 0;
  }

  const average = calculateAverage(ratings);
  const variance = ratings.reduce((total, rating) => total + (rating - average) ** 2, 0) / ratings.length;
  return Math.sqrt(variance);
};

const buildGenreInsights = (entries: { genres: string[]; score: number; movieTitle: string }[]) => {
  const genres = new Map<string, { totalScore: number; ratingsCount: number; movieKeys: Set<string> }>();

  for (const entry of entries) {
    for (const genre of entry.genres) {
      const current = genres.get(genre) ?? { totalScore: 0, ratingsCount: 0, movieKeys: new Set<string>() };
      current.totalScore += entry.score;
      current.ratingsCount += 1;
      current.movieKeys.add(entry.movieTitle);
      genres.set(genre, current);
    }
  }

  return Array.from(genres.entries())
    .map(([genre, stats]) => ({
      genre,
      averageScore: Math.round((stats.totalScore / stats.ratingsCount) * 10) / 10,
      ratingsCount: stats.ratingsCount,
      movieCount: stats.movieKeys.size,
    }))
    .sort((left, right) => {
      if (right.averageScore !== left.averageScore) {
        return right.averageScore - left.averageScore;
      }

      return right.ratingsCount - left.ratingsCount;
    });
};

const buildMovieInsights = (movies: MovieWithRatings[]) =>
  movies
    .filter((movie) => movie.avaliacoes.length > 0)
    .map((movie) => ({
      title: movie.title,
      averageScore: calculateAverage(movie.avaliacoes.map((rating) => rating.score)),
      ratingsCount: movie.avaliacoes.length,
      genres: splitGenres(movie.genres),
    }));

const buildMemberInsights = (movies: MovieWithRatings[]) => {
  const ratingsByMember = new Map<string, { userName: string; ratings: { score: number; genres: string[]; movie: MovieInsight; movieTitle: string }[] }>();

  for (const movie of movies) {
    const movieInsight: MovieInsight = {
      title: movie.title,
      averageScore: calculateAverage(movie.avaliacoes.map((rating) => rating.score)),
      ratingsCount: movie.avaliacoes.length,
      genres: splitGenres(movie.genres),
    };

    for (const rating of movie.avaliacoes) {
      const current = ratingsByMember.get(rating.user_id) ?? {
        userName: rating.user_name || "Usuário",
        ratings: [],
      };

      current.ratings.push({
        score: rating.score,
        genres: movieInsight.genres,
        movie: movieInsight,
        movieTitle: movie.title,
      });

      ratingsByMember.set(rating.user_id, current);
    }
  }

  return Array.from(ratingsByMember.values())
    .map((member) => {
      const favoriteGenres = buildGenreInsights(member.ratings)
        .filter((genre) => genre.ratingsCount >= 2)
        .slice(0, 3);
      const leastFavoriteGenres = [...buildGenreInsights(member.ratings)]
        .reverse()
        .filter((genre) => genre.ratingsCount >= 2)
        .slice(0, 2);

      return {
        userName: member.userName,
        averageScore: calculateAverage(member.ratings.map((rating) => rating.score)),
        ratingsCount: member.ratings.length,
        favoriteGenres,
        leastFavoriteGenres,
        favoriteMovies: [...member.ratings]
          .sort((left, right) => right.score - left.score)
          .map((rating) => rating.movie)
          .filter((movie, index, items) => items.findIndex((item) => item.title === movie.title) === index)
          .slice(0, 3),
      };
    })
    .sort((left, right) => right.ratingsCount - left.ratingsCount);
};

const buildGroupProfile = (movies: MovieWithRatings[]): GroupProfile => {
  const ratedMovies = movies.filter((movie) => movie.avaliacoes.length > 0);
  const movieInsights = buildMovieInsights(ratedMovies);
  const genreEntries = ratedMovies.flatMap((movie) => {
    const genres = splitGenres(movie.genres);
    return movie.avaliacoes.map((rating) => ({ genres, score: rating.score, movieTitle: movie.title }));
  });
  const genreInsights = buildGenreInsights(genreEntries).filter((genre) => genre.ratingsCount >= 2);

  return {
    totalMovies: ratedMovies.length,
    totalRatings: ratedMovies.reduce((total, movie) => total + movie.avaliacoes.length, 0),
    topGenres: genreInsights.slice(0, 5),
    lowGenres: [...genreInsights].reverse().slice(0, 3),
    favoriteMovies: [...movieInsights]
      .filter((movie) => movie.ratingsCount >= 2)
      .sort((left, right) => {
        if (right.averageScore !== left.averageScore) {
          return right.averageScore - left.averageScore;
        }

        return right.ratingsCount - left.ratingsCount;
      })
      .slice(0, 6),
    leastFavoriteMovies: [...movieInsights]
      .filter((movie) => movie.ratingsCount >= 2)
      .sort((left, right) => {
        if (left.averageScore !== right.averageScore) {
          return left.averageScore - right.averageScore;
        }

        return right.ratingsCount - left.ratingsCount;
      })
      .slice(0, 4),
    polarizingMovies: [...ratedMovies]
      .filter((movie) => movie.avaliacoes.length >= 3)
      .map((movie) => ({
        title: movie.title,
        averageScore: calculateAverage(movie.avaliacoes.map((rating) => rating.score)),
        ratingsCount: movie.avaliacoes.length,
        genres: splitGenres(movie.genres),
        deviation: calculateStandardDeviation(movie.avaliacoes.map((rating) => rating.score)),
      }))
      .sort((left, right) => right.deviation - left.deviation)
      .slice(0, 3)
      .map(({ deviation: _deviation, ...movie }) => movie),
    members: buildMemberInsights(ratedMovies).slice(0, 6),
  };
};

const formatGenreInsights = (genres: GenreInsight[]) =>
  genres.length
    ? genres.map((genre) => `${genre.genre} (${genre.averageScore}/10 em ${genre.ratingsCount} notas)`).join(", ")
    : "Nenhum gênero com sinal suficiente";

const formatMovieInsights = (movies: MovieInsight[]) =>
  movies.length
    ? movies
        .map((movie) => `${movie.title} (${movie.averageScore}/10 em ${movie.ratingsCount} notas; gêneros: ${movie.genres.join(", ") || "não informado"})`)
        .join("; ")
    : "Nenhum filme suficiente";

const formatMemberInsights = (members: MemberInsight[]) =>
  members.length
    ? members
        .map(
          (member) =>
            `${member.userName}: média ${member.averageScore}/10 em ${member.ratingsCount} notas; ` +
            `gosta de ${formatGenreInsights(member.favoriteGenres)}; ` +
            `rejeita mais ${formatGenreInsights(member.leastFavoriteGenres)}; ` +
            `favoritos ${formatMovieInsights(member.favoriteMovies)}`
        )
        .join("\n")
    : "Nenhuma preferência individual suficiente";

const extractJson = (text: string) => {
  let cleanText = text.trim();

  if (cleanText.startsWith("```")) {
    cleanText = cleanText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  }

  const firstBracketIndex = cleanText.indexOf("{");
  const lastBracketIndex = cleanText.lastIndexOf("}");

  if (firstBracketIndex >= 0 && lastBracketIndex > firstBracketIndex) {
    return cleanText.slice(firstBracketIndex, lastBracketIndex + 1);
  }

  return cleanText;
};

const buildRecommendationPrompt = (
  profile: GroupProfile,
  watchedTitles: string[],
  quantidade: number,
  genero: string | null,
  includeSeries: boolean
) => {
  const genreInstruction = genero ? `A recomendação deve priorizar fortemente o gênero "${genero}".` : "Não há restrição de gênero obrigatória.";
  const mediaInstruction = includeSeries
    ? "Você pode recomendar filmes e séries, mas só recomende séries quando elas fizerem muito sentido para o histórico do grupo."
    : "Recomende apenas filmes. Não recomende séries.";

  return [
    `Você é um curador de filmes e séries para um grupo de amigos. Gere ${quantidade} recomendações reais com alta chance de agradar o grupo.`,
    genreInstruction,
    mediaInstruction,
    "Use o histórico abaixo para identificar consenso do grupo, preferências individuais e o que deve ser evitado.",
    "Nunca recomende um título já assistido.",
    "Para cada recomendação, explique o motivo em português natural, com 2 a 3 linhas.",
    "Evite respostas genéricas.",
    "",
    `RESUMO DO GRUPO: ${profile.totalMovies} títulos avaliados e ${profile.totalRatings} notas registradas.`,
    `Gêneros favoritos: ${formatGenreInsights(profile.topGenres)}`,
    `Gêneros menos queridos: ${formatGenreInsights(profile.lowGenres)}`,
    `Filmes favoritos do grupo: ${formatMovieInsights(profile.favoriteMovies)}`,
    `Filmes com pior recepção: ${formatMovieInsights(profile.leastFavoriteMovies)}`,
    `Filmes polarizantes: ${formatMovieInsights(profile.polarizingMovies)}`,
    "",
    "PREFERÊNCIAS INDIVIDUAIS:",
    formatMemberInsights(profile.members),
    "",
    "JÁ ASSISTIDOS:",
    watchedTitles.join(", "),
    "",
    "FORMATO DE RESPOSTA:",
    JSON.stringify(
      {
        recomendacoes: [
          {
            titulo: "Nome do Filme",
            motivo: "Explique em 2 a 3 linhas o motivo da recomendação",
          },
        ],
      },
      null,
      2
    ),
    "Responda APENAS com JSON válido.",
  ].join("\n");
};

const matchesRequestedGenre = (genres: string[], genero: string | null) => {
  if (!genero) {
    return true;
  }

  const normalizedGenre = normalizeText(genero);
  return genres.some((genre) => normalizeText(genre).includes(normalizedGenre) || normalizedGenre.includes(normalizeText(genre)));
};

const deduplicateRecommendations = async (
  rawRecommendations: RecommendationItem[],
  watchedTitles: Set<string>,
  watchedTmdbIds: Set<number>,
  quantidade: number,
  genero: string | null,
  includeSeries: boolean
) => {
  const recommendations: RecommendationItem[] = [];
  const seenTitles = new Set<string>();
  const seenTmdbIds = new Set<number>();

  for (const recommendation of rawRecommendations) {
    const title = recommendation.titulo?.trim();
    const reason = recommendation.motivo?.trim();

    if (!title || !reason) {
      continue;
    }

    const tmdbInfo = await searchMovieTmdb(title);
    if (!tmdbInfo) {
      continue;
    }

    if (!includeSeries && tmdbInfo.media_type !== "movie") {
      continue;
    }

    const normalizedTitle = normalizeText(tmdbInfo.title);
    if (watchedTitles.has(normalizedTitle) || seenTitles.has(normalizedTitle)) {
      continue;
    }

    if (watchedTmdbIds.has(tmdbInfo.id) || seenTmdbIds.has(tmdbInfo.id)) {
      continue;
    }

    if (!matchesRequestedGenre(tmdbInfo.genres, genero)) {
      continue;
    }

    recommendations.push({
      titulo: tmdbInfo.title,
      motivo: reason,
    });

    seenTitles.add(normalizedTitle);
    seenTmdbIds.add(tmdbInfo.id);

    if (recommendations.length >= quantidade) {
      break;
    }
  }

  return recommendations;
};

export const buildRecommendations = async (
  movies: MovieWithRatings[],
  quantidade: number,
  genero: string | null,
  includeSeries: boolean,
  options: RecommendationOptions = {}
) => {
  await options.onProgress?.({
    step: "Analisando historico",
    detail: "Lendo notas, medias e os titulos que o grupo ja assistiu.",
  });

  const ratedMovies = movies.filter((movie) => movie.avaliacoes.length > 0);
  const profile = buildGroupProfile(ratedMovies);
  const watchedTitlesList = ratedMovies.map((movie) => movie.title).sort((left, right) => left.localeCompare(right, "pt-BR"));
  const watchedTitles = new Set(watchedTitlesList.map((title) => normalizeText(title)));
  const watchedTmdbIds = new Set(
    ratedMovies.map((movie) => movie.tmdb_id).filter((tmdbId): tmdbId is number => typeof tmdbId === "number")
  );

  await options.onProgress?.({
    step: "Mapeando preferencias",
    detail: "Separando generos favoritos, filmes mais amados e gostos individuais.",
  });

  const prompt = buildRecommendationPrompt(
    profile,
    watchedTitlesList,
    Math.max(quantidade * fallbackRecommendationMultiplier, quantidade),
    genero,
    includeSeries
  );

  await options.onProgress?.({
    step: "Explorando possibilidades",
    detail: "Cruzando o perfil do grupo com novas opcoes para montar candidatos.",
  });

  const responseText = await generateRecommendations(prompt);
  const parsed = JSON.parse(extractJson(responseText)) as RawRecommendationResponse;
  const rawRecommendations = Array.isArray(parsed.recomendacoes) ? parsed.recomendacoes : [];

  await options.onProgress?.({
    step: "Validando candidatos",
    detail: "Conferindo no TMDB, removendo repetidos e respeitando os filtros escolhidos.",
  });

  const recommendations = await deduplicateRecommendations(
    rawRecommendations,
    watchedTitles,
    watchedTmdbIds,
    quantidade,
    genero,
    includeSeries
  );

  if (!recommendations.length && genero && profile.topGenres.length && profile.favoriteMovies.length) {
    await options.onProgress?.({
      step: "Refinando busca",
      detail: "A primeira rodada veio fraca; estou ampliando a busca para encontrar opcoes melhores.",
    });

    const fallbackPrompt = buildRecommendationPrompt(
      profile,
      watchedTitlesList,
      Math.max(quantidade * fallbackRecommendationMultiplier, quantidade),
      null,
      includeSeries
    );
    const fallbackResponseText = await generateRecommendations(fallbackPrompt);
    const fallbackParsed = JSON.parse(extractJson(fallbackResponseText)) as RawRecommendationResponse;
    const fallbackRawRecommendations = Array.isArray(fallbackParsed.recomendacoes) ? fallbackParsed.recomendacoes : [];

    return deduplicateRecommendations(
      fallbackRawRecommendations,
      watchedTitles,
      watchedTmdbIds,
      quantidade,
      null,
      includeSeries
    );
  }

  await options.onProgress?.({
    step: "Finalizando lista",
    detail: "Organizando as recomendacoes finais para publicar no chat.",
  });

  return recommendations;
};
