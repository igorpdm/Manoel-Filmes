import { getDb } from "./connection";
import type { VotingRow } from "./types";

export const saveActiveVoting = async (
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

export const removeActiveVoting = async (movieKey: string) => {
    const db = getDb();
    db.prepare("DELETE FROM active_votings WHERE movie_key = ?").run(movieKey);
};

export const getActiveVotings = async () => {
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
