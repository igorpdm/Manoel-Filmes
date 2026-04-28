import fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./connection";
import { logger } from "../shared/logger";

const __dirname = dirname(fileURLToPath(import.meta.url));
const JSON_FILE = join(__dirname, "..", "movies_data.json");

export const initDb = async () => {
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

        CREATE INDEX IF NOT EXISTS idx_ratings_movie_id ON ratings(movie_id);
        CREATE INDEX IF NOT EXISTS idx_movies_tmdb_id ON movies(tmdb_id);
        CREATE INDEX IF NOT EXISTS idx_watchlist_added_at ON watchlist(added_at);
    `);

    const watchlistColumns = db.prepare("PRAGMA table_info(watchlist)").all() as { name: string }[];
    const watchlistColumnNames = watchlistColumns.map((row) => row.name);
    if (!watchlistColumnNames.includes("added_by_name")) {
        db.prepare("ALTER TABLE watchlist ADD COLUMN added_by_name TEXT").run();
    }
    if (!watchlistColumnNames.includes("genres")) {
        db.prepare("ALTER TABLE watchlist ADD COLUMN genres TEXT").run();
    }

    const moviesColumns = db.prepare("PRAGMA table_info(movies)").all() as { name: string }[];
    const movieColumnNames = moviesColumns.map((row) => row.name);
    if (!movieColumnNames.includes("genres")) {
        db.prepare("ALTER TABLE movies ADD COLUMN genres TEXT").run();
    }

    const activeVotingColumns = db.prepare("PRAGMA table_info(active_votings)").all() as { name: string; type: string }[];
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

export const migrateFromJson = async () => {
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
        logger.error("DB", "Falha ao parsear JSON de migração", e);
        return;
    }

    const db = getDb();

    const insertMovie = db.prepare(
        `INSERT INTO movies (title, tmdb_id, poster_url, overview, release_date, watched_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    const selectMovieId = db.prepare("SELECT id FROM movies WHERE title = ?");
    const lastInsertRowId = db.prepare("SELECT last_insert_rowid() as id");

    const insertRating = db.prepare(
        `INSERT OR IGNORE INTO ratings (movie_id, user_id, user_name, score, timestamp)
         VALUES (?, ?, ?, ?, ?)`
    );

    const insertVoting = db.prepare(
        `INSERT INTO active_votings (movie_key, message_id, channel_id, tmdb_info, allowed_users)
         VALUES (?, ?, ?, ?, ?)`
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
                insertMovie.run(
                    title,
                    (info.tmdb_id as number) || null,
                    (info.poster_url as string) || null,
                    (info.overview as string) || "",
                    null,
                    now,
                    now
                );
                movieId = (lastInsertRowId.get() as { id: number }).id;
            }

            const avaliacoes = (info.avaliacoes || []) as Record<string, unknown>[];
            for (const av of avaliacoes) {
                insertRating.run(
                    movieId,
                    String(av.user_id),
                    (av.user_name as string) || "",
                    Number(av.nota),
                    new Date().toISOString()
                );
            }
        }

        const votacoes = (data.votacoes_ativas || {}) as Record<string, Record<string, unknown>>;
        for (const [key, info] of Object.entries(votacoes)) {
            if (!checkVoting.get(key)) {
                insertVoting.run(
                    key,
                    String(info.message_id || ""),
                    String(info.channel_id),
                    JSON.stringify(info.tmdb_info || null),
                    JSON.stringify(info.usuarios_permitidos || [])
                );
            }
        }
    });

    try {
        transaction();
        fs.unlinkSync(JSON_FILE);
    } catch (e) {
        logger.error("DB", "Migração de JSON falhou", e);
    }
};
