import { TTLCache } from "./utils/ttl-cache";
import type { SelectedEpisode, SessionRating, TmdbSearchResult } from "../shared/types";

export type { TmdbSearchResult };


export interface VotingEntry {
    movieKey: string;
    tmdbInfo: TmdbSearchResult | null;
    allowedUsers: string[];
}

export interface ListEntry {
    movies: unknown[];
    page: number;
    botAvatarUrl: string | undefined;
}

export interface WatchlistEntry {
    page: number;
    botAvatarUrl: string | undefined;
}

export interface RecEntry {
  recommendations: { titulo: string; motivo: string }[];
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
    sessionTitle: string;
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
