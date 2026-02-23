export interface MovieRow {
    id: number;
    title: string;
    tmdb_id: number | null;
    poster_url: string | null;
    overview: string;
    release_date: string | null;
    genres: string | null;
    watched_at: string;
    created_at: string;
}

export interface RatingRow {
    id: number;
    movie_id: number;
    user_id: string;
    user_name: string;
    score: number;
    timestamp: string;
}

export interface WatchlistRow {
    id: number;
    title: string;
    tmdb_id: number | null;
    poster_url: string | null;
    overview: string;
    release_date: string | null;
    genres: string | null;
    added_by: string;
    added_by_name: string;
    added_at: string;
    recommendation_reason: string;
}

export interface VotingRow {
    movie_key: string;
    message_id: string;
    channel_id: string;
    tmdb_info: string;
    allowed_users: string;
}

export interface MovieWithRatings extends MovieRow {
    avaliacoes: RatingRow[];
}
