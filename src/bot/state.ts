import { TTLCache } from "./utils/ttl-cache";
import type { SelectedEpisode, SessionRating } from "../shared/types";

export interface TmdbSearchResult {
    id: number;
    title: string;
    poster_url: string | null;
    overview: string;
    release_date: string;
    vote_average: number;
    genres: string[];
    media_type: "movie" | "tv";
    seasons?: {
        id: number;
        seasonNumber: number;
        name: string;
        episodeCount: number;
        posterPath: string | null;
        episodes: {
            id: number;
            episodeNumber: number;
            name: string;
            overview: string;
            stillPath: string | null;
            airDate: string;
            runtime: number | null;
        }[];
    }[];
}

export interface VotingEntry {
    movieKey: string;
    tmdbInfo: TmdbSearchResult | null;
    allowedUsers: string[];
}

export interface ListEntry {
    filmes: unknown[];
    page: number;
    botAvatarUrl: string | undefined;
}

export interface WatchlistEntry {
    page: number;
    botAvatarUrl: string | undefined;
}

export interface RecEntry {
    recomendacoes: { titulo: string; motivo: string }[];
}

export interface PendingRegisterEntry {
    tmdbInfo: TmdbSearchResult | null;
    filmeBusca: string;
    usuariosIds: string[];
    usuariosNomes: string[];
}

export interface PendingWatchlistEntry {
    tmdbInfo: TmdbSearchResult;
    userId: string;
    userName: string;
    reason: string;
}

export const votingCache = new TTLCache<string, VotingEntry>();
export const listCache = new TTLCache<string, ListEntry>();
export const watchlistCache = new TTLCache<string, WatchlistEntry>();
export const recCache = new TTLCache<string, RecEntry>();
export const pendingRegisterCache = new TTLCache<string, PendingRegisterEntry>();
export const pendingWatchlistCache = new TTLCache<string, PendingWatchlistEntry>();
export const pendingRemovalCache = new TTLCache<string, string>();
export const pendingSessionCache = new TTLCache<string, PendingSession>();

export interface PendingSession {
    tmdbInfo: TmdbSearchResult;
    sala: string;
    hostId: string;
    hostUsername: string;
    channelId: string;
    guildId: string;
    selectedSeason?: number;
    selectedEpisode?: number;
}

export interface ActiveWatchSession {
    roomId: string;
    hostToken: string;
    hostDiscordId: string;
    channelId: string;
    messageId: string;
    guildId: string;
    movieName: string;
    tmdbInfo: TmdbSearchResult;
    selectedEpisode?: SelectedEpisode;
    hostUsername: string;
    createdAt: number;
}

export let activeWatchSession: ActiveWatchSession | null = null;

export function setActiveWatchSession(session: ActiveWatchSession | null) {
    activeWatchSession = session;
}