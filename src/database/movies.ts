import { getDb } from "./connection";
import type { MovieRow, RatingRow, MovieWithRatings } from "./types";

export const registerMovieStart = async (title: string, tmdbInfo: Record<string, unknown>) => {
    const db = getDb();
    const existing = db.prepare("SELECT id FROM movies WHERE title = ?").get(title);
    if (existing) return;

    const genres = Array.isArray(tmdbInfo?.genres) && tmdbInfo.genres.length
        ? (tmdbInfo.genres as string[]).join(", ")
        : null;
    const now = new Date().toISOString();

    db.prepare(
        `INSERT INTO movies (title, tmdb_id, poster_url, overview, release_date, genres, watched_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        title,
        (tmdbInfo?.id as number) || null,
        (tmdbInfo?.poster_url as string) || null,
        (tmdbInfo?.overview as string) || "",
        (tmdbInfo?.release_date as string) || "",
        genres,
        now,
        now
    );
};

export const addVote = async (title: string, userId: string, userName: string, score: number) => {
    const db = getDb();
    const movie = db.prepare("SELECT id FROM movies WHERE title = ?").get(title) as { id: number } | undefined;

    if (!movie) return false;

    db.prepare(
        `INSERT OR REPLACE INTO ratings (movie_id, user_id, user_name, score, timestamp)
         VALUES (?, ?, ?, ?, ?)`
    ).run(movie.id, String(userId), userName, score, new Date().toISOString());

    return true;
};

export const getMovieRatings = async (title: string) => {
    const db = getDb();
    const movie = db.prepare("SELECT id FROM movies WHERE title = ?").get(title) as { id: number } | undefined;

    if (!movie) return [];

    return db.prepare("SELECT * FROM ratings WHERE movie_id = ?").all(movie.id) as RatingRow[];
};

export const getAllMoviesWithRatings = async (): Promise<MovieWithRatings[]> => {
    const db = getDb();
    const movies = db.prepare("SELECT * FROM movies").all() as MovieRow[];
    const allRatings = db.prepare("SELECT * FROM ratings").all() as RatingRow[];

    const ratingsMap = new Map<number, RatingRow[]>();
    for (const rating of allRatings) {
        const existing = ratingsMap.get(rating.movie_id) ?? [];
        existing.push(rating);
        ratingsMap.set(rating.movie_id, existing);
    }

    const rawMovies: MovieWithRatings[] = movies.map((movie) => ({
        ...movie,
        avaliacoes: ratingsMap.get(movie.id) ?? [],
    }));

    const seriesMap = new Map<string, MovieWithRatings & { isSeries?: boolean; episodes?: unknown[] }>();
    const independentMovies: MovieWithRatings[] = [];

    for (const movie of rawMovies) {
        const match = movie.title.match(/^(.*?) - T(\d+)E(\d+)$/);
        if (match) {
            const seriesTitle = match[1];
            const season = parseInt(match[2]);
            const episode = parseInt(match[3]);

            if (!seriesMap.has(seriesTitle)) {
                seriesMap.set(seriesTitle, {
                    ...movie,
                    title: seriesTitle,
                    isSeries: true,
                    episodes: [],
                    avaliacoes: [],
                });
            }

            const series = seriesMap.get(seriesTitle)!;
            series.episodes!.push({ ...movie, season, episode });
            series.avaliacoes.push(...movie.avaliacoes);
        } else {
            independentMovies.push(movie);
        }
    }

    const aggregatedSeries = Array.from(seriesMap.values()).map(series => {
        (series.episodes as { season: number; episode: number }[]).sort((a, b) => {
            if (a.season !== b.season) return a.season - b.season;
            return a.episode - b.episode;
        });
        return series;
    });

    return [...independentMovies, ...aggregatedSeries];
};

export const deleteMovie = async (title: string) => {
    const db = getDb();
    const movie = db.prepare("SELECT id FROM movies WHERE title LIKE ?").get(title) as { id: number } | undefined;

    if (!movie) return false;

    db.prepare("DELETE FROM movies WHERE id = ?").run(movie.id);
    return true;
};

export const isMovieWatched = async (title: string, tmdbId: number | null = null) => {
    const db = getDb();
    let query = "SELECT id FROM movies WHERE title = ?";
    const params: (string | number)[] = [title];

    if (tmdbId) {
        query += " OR tmdb_id = ?";
        params.push(tmdbId);
    }

    const exists = db.prepare(query).get(...params);
    return !!exists;
};
