import { WebSocket } from "ws";

export interface ExtendedWebSocket extends WebSocket {
    data: ClientData;
    isAlive?: boolean;
}

export interface SubtitleInfo {
    filename: string;
    displayName: string;
}

export interface AudioTrackInfo {
    streamIndex: number;
    codec: string;
    language: string;
    title: string;
    channels: number;
    isDefault: boolean;
    isCompatible: boolean;
}

export interface RoomState {
    videoPath: string;
    pendingVideoPath: string;
    currentTime: number;
    isPlaying: boolean;
    lastUpdate: number;
    isUploading: boolean;
    uploadProgress: number;
    isAwaitingAudioSelection: boolean;
    audioTracks: AudioTrackInfo[];
    selectedAudioStreamIndex: number | null;
    isProcessing: boolean;
    processingMessage?: string;
    hostId: string;
    playbackStarted: boolean;
    hostLastHeartbeat: number;
    lastCommandSeq: number;
    subtitles: SubtitleInfo[];
}

export interface Episode {
    id: number;
    episodeNumber: number;
    name: string;
    overview: string;
    stillPath: string | null;
    airDate: string;
    runtime: number | null;
}

export interface Season {
    id: number;
    seasonNumber: number;
    name: string;
    episodeCount: number;
    posterPath: string | null;
    episodes: Episode[];
}

export interface MovieInfo {
    id: number;
    title: string;
    posterUrl: string | null;
    backdropUrl: string | null;
    overview: string;
    releaseDate: string;
    voteAverage: number;
    genres: string[];
    mediaType: 'movie' | 'tv';
    seasons?: Season[];
}

export interface SelectedEpisode {
    id?: number;
    seasonNumber: number;
    episodeNumber: number;
    name: string;
    overview?: string;
    stillPath?: string | null;
    airDate?: string;
    runtime?: number | null;
}

export interface DiscordUser {
    discordId: string;
    username: string;
    isHost: boolean;
    connected: boolean;
    connectedAt: number;
    ping?: number;
}

export interface ClientMetrics {
    lastPing: number;
    avgLatency: number;
    connectionQuality: 'good' | 'fair' | 'poor';
}

export interface SessionRating {
    discordId: string;
    username: string;
    rating: number;
}

export interface DiscordSession {
    channelId: string;
    messageId: string;
    guildId: string;
    hostDiscordId: string;
    webhookUrl?: string;
}

export type SessionStatus = 'waiting' | 'playing' | 'ended';

export interface Room {
    id: string;
    state: RoomState;
    clients: Set<ExtendedWebSocket>;
    title?: string;
    movieName?: string;
    movieInfo?: MovieInfo;
    selectedEpisode?: SelectedEpisode;
    discordSession?: DiscordSession;
    tokenMap: Map<string, DiscordUser>;
    ratings: SessionRating[];
    status: SessionStatus;
}

export interface ClientData {
    roomId: string;
    clientId: string;
    token?: string;
    discordUser?: DiscordUser;
}

export type MessageType =
    | "join"
    | "sync"
    | "play"
    | "pause"
    | "seek"
    | "state"
    | "viewers"
    | "session-status"
    | "upload-start"
    | "upload-progress"
    | "upload-complete"
    | "audio-track-selection-required"
    | "processing-progress"
    | "video-ready"
    | "ping"
    | "pong"
    | "host-heartbeat"
    | "session-ended"
    | "session-ending"
    | "rating-received"
    | "all-ratings-received"
    | "host-changed"
    | "host-inactive"
    | "update-metrics"
    | "subtitle-added";

export interface WSMessage {
    type: MessageType;
    roomId?: string;
    currentTime?: number;
    isPlaying?: boolean;
    count?: number;
    viewerCount?: number;
    viewers?: { discordId: string; username: string; ping?: number }[];
    progress?: number;
    processingMessage?: string;
    audioTracks?: AudioTrackInfo[];
    filename?: string;
    timestamp?: number;
    serverTime?: number;
    isHost?: boolean;
    seq?: number;
    status?: SessionStatus;
    rating?: number;
    ratings?: SessionRating[];
    average?: number;
    allRated?: boolean;
    movieInfo?: MovieInfo | null;
    movieName?: string;
    newHostId?: string;
    newHostUsername?: string;
    metrics?: ClientMetrics;
}
