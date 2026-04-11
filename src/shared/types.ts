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
    audioSelectionErrorMessage?: string;
    isProcessing: boolean;
    processingMessage?: string;
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

export interface EpisodeRating {
    movieName: string;
    selectedEpisode: SelectedEpisode;
    ratings: SessionRating[];
    average: number;
}

export interface DiscordUser {
    discordId: string;
    username: string;
    avatarUrl: string | null;
    isHost: boolean;
    connected: boolean;
    connectedAt: number;
    ping?: number;
}

export interface OAuthSession {
    discordId: string;
    username: string;
    avatarHash: string | null;
    globalName: string | null;
    createdAt: number;
    expiresAt: number;
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

export type RatingParticipantStatus = 'pending' | 'rated' | 'timed_out';

export type RatingRoundScope = 'session' | 'episode';

export type RatingRoundCompletionReason = 'all_rated' | 'timeout';

export interface RatingParticipant {
    discordId: string;
    username: string;
    rating: number | null;
    status: RatingParticipantStatus;
}

export interface RatingRound {
    scope: RatingRoundScope;
    startedAt: number;
    expiresAt: number;
    expectedVoters: Array<Pick<DiscordUser, 'discordId' | 'username'>>;
    isClosed: boolean;
    completionReason?: RatingRoundCompletionReason;
}

export interface RatingProgress {
    scope: RatingRoundScope;
    startedAt: number;
    expiresAt: number;
    isClosed: boolean;
    completionReason?: RatingRoundCompletionReason;
    participants: RatingParticipant[];
    ratings: SessionRating[];
    average: number;
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
    movieName?: string;
    movieInfo?: MovieInfo;
    selectedEpisode?: SelectedEpisode;
    discordSession?: DiscordSession;
    tokenMap: Map<string, DiscordUser>;
    ratings: SessionRating[];
    ratingRound?: RatingRound;
    episodeHistory: EpisodeRating[];
    pendingNextEpisode?: SelectedEpisode;
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
    | "pending-upload-cancelled"
    | "processing-progress"
    | "video-ready"
    | "ping"
    | "pong"
    | "host-heartbeat"
    | "session-ended"
    | "session-ending"
    | "session-cancelled"
    | "rating-progress"
    | "rating-received"
    | "all-ratings-received"
    | "host-changed"
    | "host-inactive"
    | "update-metrics"
    | "episode-ending"
    | "next-episode"
    | "episode-ratings-received"
    | "subtitle-added"
    | "subtitles-ready";

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
    audioSelectionErrorMessage?: string;
    errorMessage?: string;
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
    selectedEpisode?: SelectedEpisode | null;
    episodeHistory?: EpisodeRating[];
    completionReason?: RatingRoundCompletionReason;
    ratingProgress?: RatingProgress;
}

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
