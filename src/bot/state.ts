import { TTLCache } from "./utils/ttl-cache";

export const votingCache = new TTLCache<string, any>();
export const listCache = new TTLCache<string, any>();
export const watchlistCache = new TTLCache<string, any>();
export const recCache = new TTLCache<string, any>();
export const pendingRegisterCache = new TTLCache<string, any>();
export const pendingWatchlistCache = new TTLCache<string, any>();
export const pendingRemovalCache = new TTLCache<string, any>();
export const pendingSessionCache = new TTLCache<string, any>();

export interface PendingSession {
    tmdbInfo: any;
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
    tmdbInfo: any;
    selectedEpisode?: any;
    hostUsername: string;
    createdAt: number;
}

export let activeWatchSession: ActiveWatchSession | null = null;

export function setActiveWatchSession(session: ActiveWatchSession | null) {
    activeWatchSession = session;
}