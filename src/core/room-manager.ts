import type {
    Room,
    RoomState,
    WSMessage,
    DiscordUser,
    DiscordSession,
    SessionRating,
    SessionStatus,
    MovieInfo,
    ClientMetrics,
    ExtendedWebSocket,
    SelectedEpisode,
    EpisodeRating,
    RatingProgress,
    RatingRoundCompletionReason,
    RatingRoundScope
} from "../shared/types";
import { randomUUID } from "crypto";
import { logger } from "../shared/logger";
import * as auth from "./room-auth";
import * as playback from "./room-playback";
import * as broadcast from "./room-broadcast";
import * as ratings from "./room-rating";
import { removeRoomMediaFiles } from "./room-media";

const ROOM_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CLIENTS_PER_ROOM = 10;
const MAX_BANDWIDTH_MBPS = 150;
const VIEWER_BROADCAST_DEBOUNCE = 500;

export class RoomManager {
    private rooms = new Map<string, Room>();
    private cleanupInterval: NodeJS.Timeout | null = null;
    private cleanupTimers = new Map<string, NodeJS.Timeout>();
    private viewerBroadcastTimeouts = new Map<string, NodeJS.Timeout>();
    // TODO: quando abrir para vários servidores, trocar isso por sessão ativa por guild.
    private activeDiscordSession: string | null = null;

    constructor() {
        this.cleanupInterval = setInterval(() => this.cleanupInactiveRooms(), 5 * 60 * 1000);
    }

    // ─── Room Queries ─────────────────────────────────────────────────────────

    hasAnyRooms(): boolean { return this.rooms.size > 0; }
    getRoom(id: string): Room | undefined { return this.rooms.get(id); }
    forEachRoom(callback: (room: Room) => void): void { for (const room of this.rooms.values()) callback(room); }
    hasActiveDiscordSession(): boolean { return this.activeDiscordSession !== null; }

    getActiveDiscordSessionRoom(): Room | null {
        return this.activeDiscordSession ? (this.rooms.get(this.activeDiscordSession) ?? null) : null;
    }

    // ─── Room Lifecycle ───────────────────────────────────────────────────────

    createDiscordSession(
        movieName: string,
        movieInfo: MovieInfo | undefined,
        discordSession: DiscordSession & { hostUsername?: string },
        selectedEpisode?: SelectedEpisode
    ): { roomId: string; hostToken: string } | null {
        // TODO: por enquanto eu bloqueio novas salas se já tiver uma ativa.
        if (this.activeDiscordSession || this.rooms.size > 0) return null;

        const roomId = randomUUID();
        const hostToken = auth.generateToken();

        const hostUser: DiscordUser = {
            discordId: discordSession.hostDiscordId,
            username: discordSession.hostUsername || 'Host',
            avatarUrl: null,
            isHost: true,
            connected: false,
            connectedAt: Date.now(),
            ping: -1
        };

        const room: Room = {
            ...this.buildRoom(roomId),
            movieName,
            movieInfo,
            selectedEpisode,
            discordSession,
            tokenMap: new Map([[hostToken, hostUser]])
        };

        this.rooms.set(roomId, room);
        this.activeDiscordSession = roomId;
        logger.success("RoomManager", `Sessão Discord criada: ${roomId} (Host: ${hostUser.username})`);
        return { roomId, hostToken };
    }

    async deleteRoom(roomId: string): Promise<void> {
        const room = this.rooms.get(roomId);
        if (!room) return;
        logger.info("RoomManager", `Removendo sala: ${roomId}`);

        for (const client of room.clients) {
            if (client.readyState === WebSocket.OPEN) client.close(1000, "Sala encerrada");
        }
        room.clients.clear();

        await removeRoomMediaFiles(room, "remoção de sala");

        if (this.activeDiscordSession === roomId) this.activeDiscordSession = null;
        this.rooms.delete(roomId);
    }

    private cleanupInactiveRooms(): void {
        const now = Date.now();
        for (const [roomId, room] of this.rooms) {
            if (room.clients.size === 0 && now - room.state.lastUpdate > ROOM_TIMEOUT_MS) {
                this.deleteRoom(roomId);
            }
        }
    }

    // ─── Client Management ────────────────────────────────────────────────────

    addClient(roomId: string, ws: ExtendedWebSocket): boolean {
        const room = this.rooms.get(roomId);
        if (!room) return false;

        const existingTimer = this.cleanupTimers.get(roomId);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.cleanupTimers.delete(roomId);
        }

        if (room.clients.size >= MAX_CLIENTS_PER_ROOM) {
            logger.warn("RoomManager", `Conexão rejeitada: sala ${roomId} cheia (${room.clients.size}/${MAX_CLIENTS_PER_ROOM})`);
            return false;
        }

        const estimatedBitrate = playback.estimateBitrate(room);
        const currentBandwidth = room.clients.size * estimatedBitrate;

        if (currentBandwidth + estimatedBitrate > MAX_BANDWIDTH_MBPS) {
            logger.warn("RoomManager", `Conexão rejeitada: limite de banda atingido para sala ${roomId}. Uso estimado: ${currentBandwidth.toFixed(1)} + ${estimatedBitrate.toFixed(1)} > ${MAX_BANDWIDTH_MBPS} Mbps`);
            return false;
        }

        room.clients.add(ws);
        logger.debug("Room", `Cliente conectado. Room: ${roomId}, Total: ${room.clients.size}, Banda est.: ${(currentBandwidth + estimatedBitrate).toFixed(1)} Mbps`);
        this.broadcastViewerCountDebounced(roomId);
        return true;
    }

    removeClient(roomId: string, ws: ExtendedWebSocket): void {
        const room = this.rooms.get(roomId);
        if (!room) return;
        room.clients.delete(ws);
        logger.debug("Room", `Cliente desconectado. Room: ${roomId}, Total: ${room.clients.size}`);

        if (ws.data.token) {
            const stillConnected = Array.from(room.clients).some(c => c.data.token === ws.data.token);
            if (!stillConnected) auth.markUserDisconnected(room, ws.data.token);
        }

        if (room.clients.size === 0) {
            this.scheduleRoomCleanup(roomId);
        } else {
            this.broadcastViewerCountDebounced(roomId);
        }
    }

    getClientCount(roomId: string): number {
        return this.rooms.get(roomId)?.clients.size ?? 0;
    }

    private scheduleRoomCleanup(roomId: string): void {
        const existing = this.cleanupTimers.get(roomId);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
            const room = this.rooms.get(roomId);
            if (room && room.clients.size === 0) this.deleteRoom(roomId);
            this.cleanupTimers.delete(roomId);
        }, 30000);

        this.cleanupTimers.set(roomId, timer);
    }

    // ─── Auth ─────────────────────────────────────────────────────────────────

    generateUserToken(roomId: string, discordId: string, username: string, avatarUrl: string | null = null): string | null {
        const room = this.rooms.get(roomId);
        if (!room || !room.discordSession) return null;
        return auth.generateUserToken(room, discordId, username, avatarUrl);
    }

    authorizeUserByOAuth(roomId: string, discordId: string, username: string, avatarUrl: string | null): string | null {
        const room = this.rooms.get(roomId);
        if (!room || !room.discordSession) return null;

        for (const [token, user] of room.tokenMap) {
            if (user.discordId === discordId) {
                user.username = username;
                user.avatarUrl = avatarUrl;
                return token;
            }
        }

        return auth.generateUserToken(room, discordId, username, avatarUrl);
    }

    updateUserAvatar(roomId: string, discordId: string, avatarUrl: string | null): void {
        const room = this.rooms.get(roomId);
        if (!room) return;

        for (const user of room.tokenMap.values()) {
            if (user.discordId === discordId) {
                user.avatarUrl = avatarUrl;
                break;
            }
        }
    }

    validateToken(roomId: string, token: string): DiscordUser | null {
        const room = this.rooms.get(roomId);
        return room ? auth.validateToken(room, token) : null;
    }

    findAuthorizedUserByDiscordId(roomId: string, discordId: string): { token: string; user: DiscordUser } | null {
        const room = this.rooms.get(roomId);
        return room ? auth.findAuthorizedUserByDiscordId(room, discordId) : null;
    }

    markUserConnected(roomId: string, token: string): void {
        const room = this.rooms.get(roomId);
        if (room) auth.markUserConnected(room, token);
    }

    markUserDisconnected(roomId: string, token: string): void {
        const room = this.rooms.get(roomId);
        if (room) auth.markUserDisconnected(room, token);
    }

    getConnectedUsers(roomId: string): DiscordUser[] {
        const room = this.rooms.get(roomId);
        return room ? auth.getConnectedUsers(room) : [];
    }

    updateUserMetrics(roomId: string, token: string, metrics: ClientMetrics): void {
        const room = this.rooms.get(roomId);
        if (room) auth.updateUserMetrics(room, token, metrics);
    }

    isHostByToken(roomId: string, token: string): boolean {
        const room = this.rooms.get(roomId);
        return room ? auth.isHostByToken(room, token) : false;
    }

    isHostInactive(roomId: string): boolean {
        const room = this.rooms.get(roomId);
        return room ? playback.isHostInactive(room) : false;
    }

    transferHost(roomId: string): { newHostId: string; newHostUsername: string; token: string } | null {
        const room = this.rooms.get(roomId);
        return room ? auth.transferHost(room) : null;
    }

    // ─── Playback ─────────────────────────────────────────────────────────────

    getCurrentTime(roomId: string): number {
        const room = this.rooms.get(roomId);
        return room ? playback.getCurrentTime(room) : 0;
    }

    getSyncInterval(roomId: string): number {
        const room = this.rooms.get(roomId);
        return room ? playback.getSyncInterval(room) : 5000;
    }

    hasVideo(roomId: string): boolean {
        const room = this.rooms.get(roomId);
        return room ? playback.hasVideo(room) : false;
    }

    setVideoPath(roomId: string, path: string): void {
        const room = this.rooms.get(roomId);
        if (room) playback.setVideoPath(room, path);
    }

    updateState(roomId: string, updates: Partial<RoomState>): void {
        const room = this.rooms.get(roomId);
        if (room) playback.updateState(room, updates);
    }

    updateHostHeartbeat(roomId: string): void {
        const room = this.rooms.get(roomId);
        if (room) playback.updateHostHeartbeat(room);
    }

    setLastCommandSeq(roomId: string, seq: number): void {
        const room = this.rooms.get(roomId);
        if (room) playback.setLastCommandSeq(room, seq);
    }

    getLastCommandSeq(roomId: string): number {
        const room = this.rooms.get(roomId);
        return room ? playback.getLastCommandSeq(room) : 0;
    }

    // ─── Broadcast ────────────────────────────────────────────────────────────

    broadcast(roomId: string, message: WSMessage | string, exclude?: ExtendedWebSocket): void {
        const room = this.rooms.get(roomId);
        if (room) broadcast.broadcast(room, message, exclude);
    }

    broadcastAll(roomId: string, message: WSMessage | string): void {
        const room = this.rooms.get(roomId);
        if (room) broadcast.broadcastAll(room, message);
    }

    broadcastViewerCountDebounced(roomId: string): void {
        const existing = this.viewerBroadcastTimeouts.get(roomId);
        if (existing) clearTimeout(existing);

        const timeout = setTimeout(() => {
            this.broadcastViewerCount(roomId);
            this.viewerBroadcastTimeouts.delete(roomId);
        }, VIEWER_BROADCAST_DEBOUNCE);

        this.viewerBroadcastTimeouts.set(roomId, timeout);
    }

    broadcastViewerCount(roomId: string): void {
        const room = this.rooms.get(roomId);
        if (room) broadcast.broadcastViewerCount(room, auth.getConnectedUsers(room));
    }

    // ─── Session & Ratings ────────────────────────────────────────────────────

    setSessionStatus(roomId: string, status: SessionStatus): void {
        const room = this.rooms.get(roomId);
        if (!room) return;
        room.status = status;
        logger.info("Room", `Status atualizado para '${status}' na sala ${roomId}`);
    }

    addRating(roomId: string, discordId: string, username: string, rating: number): boolean {
        const room = this.rooms.get(roomId);
        return room ? ratings.addRating(room, discordId, username, rating) : false;
    }

    getRatings(roomId: string): { ratings: SessionRating[]; average: number } {
        const room = this.rooms.get(roomId);
        return room ? ratings.getRatings(room) : { ratings: [], average: 0 };
    }

    allUsersRated(roomId: string): boolean {
        const room = this.rooms.get(roomId);
        return room ? ratings.allUsersRated(room) : false;
    }

    startRatingRound(roomId: string, scope: RatingRoundScope, durationMs: number): RatingProgress | null {
        const room = this.rooms.get(roomId);
        return room ? ratings.startRatingRound(room, scope, durationMs) : null;
    }

    getRatingProgress(roomId: string): RatingProgress | null {
        const room = this.rooms.get(roomId);
        return room ? ratings.getRatingProgress(room) : null;
    }

    isRatingRoundParticipant(roomId: string, discordId: string): boolean {
        const room = this.rooms.get(roomId);
        return room ? ratings.isRatingRoundParticipant(room, discordId) : false;
    }

    finishRatingRound(roomId: string, completionReason: RatingRoundCompletionReason): RatingProgress | null {
        const room = this.rooms.get(roomId);
        return room ? ratings.finishRatingRound(room, completionReason) : null;
    }

    clearRatingRound(roomId: string): void {
        const room = this.rooms.get(roomId);
        if (room) ratings.clearRatingRound(room);
    }

    // ─── Subtitles ────────────────────────────────────────────────────────────

    addSubtitle(roomId: string, filename: string, displayName: string): boolean {
        const room = this.rooms.get(roomId);
        if (!room) return false;
        if (!room.state.subtitles.some(s => s.filename === filename)) {
            room.state.subtitles.push({ filename, displayName });
        }
        return true;
    }

    removeSubtitle(roomId: string, filename: string): boolean {
        const room = this.rooms.get(roomId);
        if (!room) return false;
        const idx = room.state.subtitles.findIndex(s => s.filename === filename);
        if (idx >= 0) { room.state.subtitles.splice(idx, 1); return true; }
        return false;
    }

    getSubtitles(roomId: string): { filename: string; displayName: string }[] {
        return this.rooms.get(roomId)?.state.subtitles ?? [];
    }

    // ─── Episode Management ──────────────────────────────────────────────────

    saveCurrentEpisodeToHistory(roomId: string): void {
        const room = this.rooms.get(roomId);
        if (!room || !room.selectedEpisode) return;

        const sum = room.ratings.reduce((acc, r) => acc + r.rating, 0);
        const average = room.ratings.length > 0
            ? Math.round(sum / room.ratings.length * 10) / 10
            : 0;

        room.episodeHistory.push({
            movieName: room.movieName || 'Episódio',
            selectedEpisode: { ...room.selectedEpisode },
            ratings: [...room.ratings],
            average,
        });

        logger.info("RoomManager", `Episódio salvo no histórico: ${room.movieName} (${room.ratings.length} avaliações, média ${average})`);
    }

    async resetForNextEpisode(roomId: string): Promise<void> {
        const room = this.rooms.get(roomId);
        if (!room) return;

        await removeRoomMediaFiles(room, "transição de episódio");

        room.state.videoPath = '';
        room.state.pendingVideoPath = '';
        room.state.currentTime = 0;
        room.state.isPlaying = false;
        room.state.lastUpdate = Date.now();
        room.state.isUploading = false;
        room.state.uploadProgress = 0;
        room.state.isAwaitingAudioSelection = false;
        room.state.audioTracks = [];
        room.state.selectedAudioStreamIndex = null;
        room.state.audioSelectionErrorMessage = '';
        room.state.isProcessing = false;
        room.state.processingMessage = '';
        room.state.playbackStarted = false;
        room.state.lastCommandSeq = 0;
        room.state.subtitles = [];
        room.ratings = [];
        room.ratingRound = undefined;
        room.status = 'waiting';

        logger.info("RoomManager", `Sala ${roomId} resetada para próximo episódio`);
    }

    updateEpisodeInfo(roomId: string, selectedEpisode: SelectedEpisode, movieName: string): void {
        const room = this.rooms.get(roomId);
        if (!room) return;
        room.selectedEpisode = selectedEpisode;
        room.movieName = movieName;
        logger.info("RoomManager", `Episódio atualizado: ${movieName}`);
    }

    getEpisodeHistory(roomId: string): EpisodeRating[] {
        return this.rooms.get(roomId)?.episodeHistory ?? [];
    }

    getNextEpisode(roomId: string): SelectedEpisode | null {
        const room = this.rooms.get(roomId);
        if (!room?.selectedEpisode || !room.movieInfo?.seasons) return null;

        const { seasonNumber, episodeNumber } = room.selectedEpisode;
        const season = room.movieInfo.seasons.find(s => s.seasonNumber === seasonNumber);
        if (!season) return null;

        const nextEp = season.episodes.find(e => e.episodeNumber === episodeNumber + 1);
        if (nextEp) {
            return { ...nextEp, seasonNumber };
        }

        const nextSeason = room.movieInfo.seasons.find(s => s.seasonNumber === seasonNumber + 1);
        if (nextSeason?.episodes?.length) {
            const firstEp = nextSeason.episodes[0];
            return { ...firstEp, seasonNumber: nextSeason.seasonNumber };
        }

        return null;
    }

    // ─── Private Helpers ──────────────────────────────────────────────────────

    private buildRoom(id: string, videoPath = ''): Room {
        return {
            id,
            state: {
                videoPath,
                pendingVideoPath: '',
                currentTime: 0,
                isPlaying: false,
                lastUpdate: Date.now(),
                isUploading: false,
                uploadProgress: 0,
                isAwaitingAudioSelection: false,
                audioTracks: [],
                selectedAudioStreamIndex: null,
                audioSelectionErrorMessage: '',
                isProcessing: false,
                processingMessage: '',
                playbackStarted: false,
                hostLastHeartbeat: Date.now(),
                lastCommandSeq: 0,
                subtitles: []
            },
            clients: new Set(),
            tokenMap: new Map(),
            ratings: [],
            episodeHistory: [],
            status: 'waiting'
        };
    }

}

export const roomManager = new RoomManager();
