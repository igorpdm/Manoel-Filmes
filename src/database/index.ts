import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { logger } from "../shared/logger";
import type { MovieRow, RatingRow, WatchlistRow, VotingRow, MovieWithRatings } from "./types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_FILE = join(__dirname, "..", "movies.db");
const JSON_FILE = join(__dirname, "..", "movies_data.json");

let dbInstance: Database.Database | undefined;

const getDb = (): Database.Database => {
  if (!dbInstance) {
    dbInstance = new Database(DB_FILE);
    dbInstance.pragma('journal_mode = WAL');
  }
  return dbInstance;
};

const initDb = async () => {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS movies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT UNIQUE NOT NULL,
      tmdb_id INTEGER,
      poster_url TEXT,
      overview TEXT,
      release_date TEXT,
      genres TEXT,
      watched_at TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      movie_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT,
      score INTEGER NOT NULL,
      timestamp TEXT,
      FOREIGN KEY (movie_id) REFERENCES movies (id) ON DELETE CASCADE,
      UNIQUE(movie_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT UNIQUE NOT NULL,
      tmdb_id INTEGER,
      poster_url TEXT,
      overview TEXT,
      release_date TEXT,
      genres TEXT,
      added_by TEXT,
      added_at TEXT,
      recommendation_reason TEXT,
      added_by_name TEXT
    );

    CREATE TABLE IF NOT EXISTS active_votings (
      movie_key TEXT PRIMARY KEY,
      message_id TEXT,
      channel_id TEXT,
      tmdb_info TEXT,
      allowed_users TEXT
    );
  `);

  const watchlistColumns = db.pragma("table_info(watchlist)") as { name: string }[];
  const watchlistColumnNames = watchlistColumns.map((row) => row.name);
  if (!watchlistColumnNames.includes("added_by_name")) {
    db.prepare("ALTER TABLE watchlist ADD COLUMN added_by_name TEXT").run();
  }
  if (!watchlistColumnNames.includes("genres")) {
    db.prepare("ALTER TABLE watchlist ADD COLUMN genres TEXT").run();
  }

  const moviesColumns = db.pragma("table_info(movies)") as { name: string }[];
  const movieColumnNames = moviesColumns.map((row) => row.name);
  if (!movieColumnNames.includes("genres")) {
    db.prepare("ALTER TABLE movies ADD COLUMN genres TEXT").run();
  }

  const activeVotingColumns = db.pragma("table_info(active_votings)") as { name: string; type: string }[];
  const messageIdColumn = activeVotingColumns.find((column) => column.name === "message_id");
  if (messageIdColumn && messageIdColumn.type.toUpperCase() !== "TEXT") {
    db.exec(`
      ALTER TABLE active_votings RENAME TO active_votings_legacy;
      CREATE TABLE active_votings (
        movie_key TEXT PRIMARY KEY,
        message_id TEXT,
        channel_id TEXT,
        tmdb_info TEXT,
        allowed_users TEXT
      );
      INSERT INTO active_votings (movie_key, message_id, channel_id, tmdb_info, allowed_users)
      SELECT movie_key, CAST(message_id AS TEXT), channel_id, tmdb_info, allowed_users
      FROM active_votings_legacy;
      DROP TABLE active_votings_legacy;
    `);
  }
};

const migrateFromJson = async () => {
  if (!fs.existsSync(JSON_FILE)) {
    return;
  }

  let data: Record<string, unknown>;
  try {
    const content = fs.readFileSync(JSON_FILE, "utf8").trim();
    if (!content) {
      return;
    }
    data = JSON.parse(content);
  } catch (e) {
    logger.error("[DB] Failed to parse migration JSON:", "migrateFromJson", e);
    return;
  }

  const db = getDb();

  const insertMovie = db.prepare(
    `INSERT INTO movies (title, tmdb_id, poster_url, overview, release_date, watched_at, created_at)
     VALUES (@title, @tmdb_id, @poster_url, @overview, @release_date, @watched_at, @created_at)`
  );

  const selectMovieId = db.prepare("SELECT id FROM movies WHERE title = ?");
  const lastInsertRowId = db.prepare("SELECT last_insert_rowid() as id");

  const insertRating = db.prepare(
    `INSERT OR IGNORE INTO ratings (movie_id, user_id, user_name, score, timestamp)
     VALUES (@movie_id, @user_id, @user_name, @score, @timestamp)`
  );

  const insertVoting = db.prepare(
    `INSERT INTO active_votings (movie_key, message_id, channel_id, tmdb_info, allowed_users)
     VALUES (@key, @message_id, @channel_id, @tmdb_info, @allowed_users)`
  );

  const checkVoting = db.prepare("SELECT movie_key FROM active_votings WHERE movie_key = ?");

  const transaction = db.transaction(() => {
    const filmes = (data.filmes || {}) as Record<string, Record<string, unknown>>;
    for (const [title, info] of Object.entries(filmes)) {
      let movieId: number | bigint;
      const existing = selectMovieId.get(title) as { id: number } | undefined;

      if (existing) {
        movieId = existing.id;
      } else {
        const now = new Date().toISOString();
        insertMovie.run({
          title,
          tmdb_id: (info.tmdb_id as number) || null,
          poster_url: (info.poster_url as string) || null,
          overview: (info.overview as string) || "",
          release_date: null,
          watched_at: now,
          created_at: now
        });
        movieId = (lastInsertRowId.get() as { id: number }).id;
      }

      const avaliacoes = (info.avaliacoes || []) as Record<string, unknown>[];
      for (const av of avaliacoes) {
        insertRating.run({
          movie_id: movieId,
          user_id: String(av.user_id),
          user_name: (av.user_name as string) || "",
          score: Number(av.nota),
          timestamp: new Date().toISOString()
        });
      }
    }

    const votacoes = (data.votacoes_ativas || {}) as Record<string, Record<string, unknown>>;
    for (const [key, info] of Object.entries(votacoes)) {
      if (!checkVoting.get(key)) {
        insertVoting.run({
          key,
          message_id: info.message_id,
          channel_id: String(info.channel_id),
          tmdb_info: JSON.stringify(info.tmdb_info || null),
          allowed_users: JSON.stringify(info.usuarios_permitidos || [])
        });
      }
    }
  });

  try {
    transaction();
    fs.unlinkSync(JSON_FILE);
  } catch (e) {
    logger.error("[DB] Migration failed:", "migrateFromJson", e);
  }
};

const saveActiveVoting = async (
  movieKey: string,
  messageId: string,
  channelId: string,
  tmdbInfo: unknown,
  allowedUsers: string[]
) => {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO active_votings (movie_key, message_id, channel_id, tmdb_info, allowed_users)
     VALUES (?, ?, ?, ?, ?)`
  ).run(movieKey, messageId, channelId, JSON.stringify(tmdbInfo || null), JSON.stringify(allowedUsers || []));
};

const removeActiveVoting = async (movieKey: string) => {
  const db = getDb();
  db.prepare("DELETE FROM active_votings WHERE movie_key = ?").run(movieKey);
};

const getActiveVotings = async () => {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM active_votings").all() as VotingRow[];

  const votings: Record<string, unknown> = {};
  for (const row of rows) {
    votings[row.movie_key] = {
      message_id: row.message_id,
      channel_id: row.channel_id,
      tmdb_info: row.tmdb_info ? JSON.parse(row.tmdb_info) : null,
      usuarios_permitidos: row.allowed_users ? JSON.parse(row.allowed_users) : [],
    };
  }
  return votings;
};

const registerMovieStart = async (title: string, tmdbInfo: Record<string, unknown>) => {
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

const addVote = async (title: string, userId: string, userName: string, score: number) => {
  const db = getDb();
  const movie = db.prepare("SELECT id FROM movies WHERE title = ?").get(title) as { id: number } | undefined;

  if (!movie) return false;

  db.prepare(
    `INSERT OR REPLACE INTO ratings (movie_id, user_id, user_name, score, timestamp)
     VALUES (?, ?, ?, ?, ?)`
  ).run(movie.id, String(userId), userName, score, new Date().toISOString());

  return true;
};

const getMovieRatings = async (title: string) => {
  const db = getDb();
  const movie = db.prepare("SELECT id FROM movies WHERE title = ?").get(title) as { id: number } | undefined;

  if (!movie) return [];

  return db.prepare("SELECT * FROM ratings WHERE movie_id = ?").all(movie.id) as RatingRow[];
};

const getAllMoviesWithRatings = async (): Promise<MovieWithRatings[]> => {
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

const addToWatchlist = async (
  title: string,
  tmdbInfo: Record<string, unknown>,
  userId: string,
  userName: string,
  reason = ""
) => {
  const db = getDb();
  const genres = Array.isArray(tmdbInfo?.genres) && tmdbInfo.genres.length
    ? (tmdbInfo.genres as string[]).join(", ")
    : null;

  try {
    db.prepare(
      `INSERT INTO watchlist (title, tmdb_id, poster_url, overview, release_date, genres, added_by, added_by_name, added_at, recommendation_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      title,
      (tmdbInfo?.id as number) || null,
      (tmdbInfo?.poster_url as string) || null,
      (tmdbInfo?.overview as string) || "",
      (tmdbInfo?.release_date as string) || "",
      genres,
      String(userId),
      userName,
      new Date().toISOString(),
      reason
    );
    return true;
  } catch {
    return false;
  }
};

const getWatchlist = async (page = 0, perPage = 5) => {
  const db = getDb();
  const offset = page * perPage;

  const items = db.prepare("SELECT * FROM watchlist ORDER BY added_at DESC LIMIT ? OFFSET ?").all(perPage, offset) as WatchlistRow[];
  const countResult = db.prepare("SELECT COUNT(*) as total FROM watchlist").get() as { total: number };

  return { items, total: countResult.total };
};

const removeFromWatchlist = async (title: string, userId: string) => {
  const db = getDb();
  const row = db.prepare("SELECT added_by FROM watchlist WHERE title = ?").get(title) as { added_by: string } | undefined;

  if (!row) return "not_found";
  if (row.added_by !== String(userId)) return "not_owner";

  db.prepare("DELETE FROM watchlist WHERE title = ?").run(title);
  return "deleted";
};

const removeFromWatchlistByTitle = async (title: string) => {
  const db = getDb();
  db.prepare("DELETE FROM watchlist WHERE title = ?").run(title);
};

const deleteMovie = async (title: string) => {
  const db = getDb();
  const movie = db.prepare("SELECT id FROM movies WHERE title LIKE ?").get(title) as { id: number } | undefined;

  if (!movie) return false;

  db.prepare("DELETE FROM movies WHERE id = ?").run(movie.id);
  return true;
};

const isMovieWatched = async (title: string, tmdbId: number | null = null) => {
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

const dbApi = {
  initDb,
  migrateFromJson,
  saveActiveVoting,
  removeActiveVoting,
  getActiveVotings,
  registerMovieStart,
  addVote,
  getMovieRatings,
  getAllMoviesWithRatings,
  addToWatchlist,
  getWatchlist,
  removeFromWatchlist,
  removeFromWatchlistByTitle,
  deleteMovie,
  isMovieWatched,
};

export default dbApi;
