import { getDb } from "./connection";
import type { WatchlistRow } from "./types";

export const addToWatchlist = async (
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

export const getWatchlist = async (page = 0, perPage = 5) => {
    const db = getDb();
    const offset = page * perPage;

    const items = db.prepare("SELECT * FROM watchlist ORDER BY added_at DESC LIMIT ? OFFSET ?").all(perPage, offset) as WatchlistRow[];
    const countResult = db.prepare("SELECT COUNT(*) as total FROM watchlist").get() as { total: number };

    return { items, total: countResult.total };
};

export const removeFromWatchlist = async (title: string, userId: string) => {
    const db = getDb();
    const row = db.prepare("SELECT added_by FROM watchlist WHERE title = ?").get(title) as { added_by: string } | undefined;

    if (!row) return "not_found";
    if (row.added_by !== String(userId)) return "not_owner";

    db.prepare("DELETE FROM watchlist WHERE title = ?").run(title);
    return "deleted";
};

export const removeFromWatchlistByTitle = async (title: string) => {
    const db = getDb();
    db.prepare("DELETE FROM watchlist WHERE LOWER(title) = LOWER(?)").run(title);
};
