import { WebSocket } from "ws";
import type {
    Room,
    RoomState,
    ClientData,
    WSMessage,
    DiscordUser,
    DiscordSession,
    SessionRating,
    SessionStatus,
    MovieInfo,
    ClientMetrics,
    ExtendedWebSocket,
    SelectedEpisode
} from "../shared/types";
import { existsSync, statSync } from "fs";
import { rm } from "fs/promises";
import { randomUUID, randomBytes } from "crypto";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { UPLOADS_DIR } from "../config";
import { logger } from "../shared/logger";

const ROOM_TIMEOUT_MS = 10 * 60 * 1000; // Reduced to 10 minutes
const MAX_CLIENTS_PER_ROOM = 10;
const MAX_BANDWIDTH_MBPS = 150;
const DEFAULT_BITRATE_MBPS = 15; // Assume 15 Mbps if file not ready
const HOST_INACTIVE_TIMEOUT = 60 * 1000;
const VIEWER_BROADCAST_DEBOUNCE = 500;

export class RoomManager {
    private rooms = new Map<string, Room>();
    private cleanupInterval: NodeJS.Timeout | null = null;
    private cleanupTimers = new Map<string, NodeJS.Timeout>();
    private viewerBroadcastTimeouts = new Map<string, NodeJS.Timeout>();
    private activeDiscordSession: string | null = null;

    constructor() {
        this.cleanupInterval = setInterval(() => this.cleanupInactiveRooms(), 5 * 60 * 1000);
    }

    hasAnyRooms(): boolean {
        return this.rooms.size > 0;
    }

    hasActiveDiscordSession(): boolean {
        return this.activeDiscordSession !== null;
    }

    getActiveDiscordSessionRoom(): Room | null {
        if (!this.activeDiscordSession) return null;
        return this.rooms.get(this.activeDiscordSession) || null;
    }

    createDiscordSession(
        title: string,
        movieName: string,
        movieInfo: MovieInfo | undefined,
        discordSession: DiscordSession & { hostUsername?: string },
        selectedEpisode?: SelectedEpisode
    ): { roomId: string; hostToken: string } | null {
        if (this.activeDiscordSession || this.rooms.size > 0) {
            return null;
        }

        const roomId = this.generateId();
        const hostToken = this.generateToken();
        const hostId = this.generateId();

        const hostUser: DiscordUser = {
            discordId: discordSession.hostDiscordId,
            username: discordSession.hostUsername || 'Host',
            isHost: true,
            connected: false,
            connectedAt: Date.now(),
            ping: -1
        };

        const room: Room = {
            id: roomId,
            state: {
                videoPath: '',
                currentTime: 0,
                isPlaying: false,
                lastUpdate: Date.now(),
                isUploading: false,
                uploadProgress: 0,
                isProcessing: false,
                processingMessage: '',
                hostId,
                playbackStarted: false,
                hostLastHeartbeat: Date.now(),
                lastCommandSeq: 0,
                subtitles: []
            },
            clients: new Set(),
            title,
            movieName,
            movieInfo,
            selectedEpisode,
            discordSession,
            tokenMap: new Map([[hostToken, hostUser]]),
            ratings: [],
            status: 'waiting'
        };

        this.rooms.set(roomId, room);
        this.activeDiscordSession = roomId;
        
        logger.success("RoomManager", `Sessão Discord criada: ${roomId} (Host: ${hostUser.username})`);
        return { roomId, hostToken };
    }

    generateUserToken(roomId: string, discordId: string, username: string): string | null {
        const room = this.rooms.get(roomId);
        if (!room || !room.discordSession) return null;

        for (const [token, user] of room.tokenMap) {
            if (user.discordId === discordId) {
                return token;
            }
        }

        const token = this.generateToken();
        room.tokenMap.set(token, {
            discordId,
            username,
            isHost: false,
            connected: false,
            connectedAt: 0,
            ping: -1
        });
        return token;
    }

    validateToken(roomId: string, token: string): DiscordUser | null {
        const room = this.rooms.get(roomId);
        if (!room) return null;
        return room.tokenMap.get(token) || null;
    }

    markUserConnected(roomId: string, token: string): void {
        const room = this.rooms.get(roomId);
        if (!room) return;

        const user = room.tokenMap.get(token);
        if (user) {
            user.connected = true;
            if (user.connectedAt === 0) {
                user.connectedAt = Date.now();
            }
            logger.info("Room", `Usuário conectado: ${user.username} (Room: ${roomId})`);
        }
    }

    markUserDisconnected(roomId: string, token: string): void {
        const room = this.rooms.get(roomId);
        if (!room) return;

        const user = room.tokenMap.get(token);
        if (user) {
            user.connected = false;
            logger.info("Room", `Usuário desconectado: ${user.username} (Room: ${roomId})`);
        }
    }

    getConnectedUsers(roomId: string): DiscordUser[] {
        const room = this.rooms.get(roomId);
        if (!room) return [];

        return Array.from(room.tokenMap.values()).filter(u => u.connected);
    }

    updateUserMetrics(roomId: string, token: string, metrics: ClientMetrics): void {
        const room = this.rooms.get(roomId);
        if (!room) return;

        const user = room.tokenMap.get(token);
        if (user) {
            user.ping = metrics.lastPing;
        }
    }

    setSessionStatus(roomId: string, status: SessionStatus): void {
        const room = this.rooms.get(roomId);
        if (room) {
            room.status = status;
            logger.info("Room", `Status atualizado para '${status}' na sala ${roomId}`);
        }
    }

    addRating(roomId: string, discordId: string, username: string, rating: number): boolean {
        const room = this.rooms.get(roomId);
        if (!room) return false;

        const existingIndex = room.ratings.findIndex(r => r.discordId === discordId);
        if (existingIndex >= 0) {
            room.ratings[existingIndex].rating = rating;
        } else {
            room.ratings.push({ discordId, username, rating });
        }
        logger.info("Room", `Nota registrada: ${username} deu nota ${rating} na sala ${roomId}`);
        return true;
    }

    getRatings(roomId: string): { ratings: SessionRating[]; average: number } {
        const room = this.rooms.get(roomId);
        if (!room || room.ratings.length === 0) {
            return { ratings: [], average: 0 };
        }

        const sum = room.ratings.reduce((acc, r) => acc + r.rating, 0);
        const average = sum / room.ratings.length;

        return { ratings: room.ratings, average: Math.round(average * 10) / 10 };
    }

    allUsersRated(roomId: string): boolean {
        const room = this.rooms.get(roomId);
        if (!room) return false;

        const connectedUsers = this.getConnectedUsers(roomId);
        if (connectedUsers.length === 0) return true;

        return connectedUsers.every(user =>
            room.ratings.some(r => r.discordId === user.discordId)
        );
    }

    createRoom(videoPath?: string): string {
        const id = this.generateId();
        const hostId = this.generateId();
        const room: Room = {
            id,
            state: {
                videoPath: videoPath || '',
                currentTime: 0,
                isPlaying: false,
                lastUpdate: Date.now(),
                isUploading: false,
                uploadProgress: 0,
                isProcessing: false,
                processingMessage: '',
                hostId,
                playbackStarted: false,
                hostLastHeartbeat: Date.now(),
                lastCommandSeq: 0,
                subtitles: []
            },
            clients: new Set(),
            tokenMap: new Map(),
            ratings: [],
            status: 'waiting'
        };
        this.rooms.set(id, room);
        logger.info("RoomManager", `Sala simples criada: ${id}`);
        return id;
    }

    addSubtitle(roomId: string, filename: string, displayName: string): boolean {
        const room = this.rooms.get(roomId);
        if (!room) return false;
        const exists = room.state.subtitles.some(s => s.filename === filename);
        if (!exists) {
            room.state.subtitles.push({ filename, displayName });
        }
        return true;
    }

    removeSubtitle(roomId: string, filename: string): boolean {
        const room = this.rooms.get(roomId);
        if (!room) return false;
        const idx = room.state.subtitles.findIndex(s => s.filename === filename);
        if (idx >= 0) {
            room.state.subtitles.splice(idx, 1);
            return true;
        }
        return false;
    }

    getSubtitles(roomId: string): { filename: string; displayName: string }[] {
        const room = this.rooms.get(roomId);
        return room?.state.subtitles || [];
    }

    getRoom(id: string): Room | undefined {
        return this.rooms.get(id);
    }

    getHostId(roomId: string): string {
        const room = this.rooms.get(roomId);
        return room?.state.hostId || '';
    }

    isHost(roomId: string, clientId: string): boolean {
        const room = this.rooms.get(roomId);
        return room?.state.hostId === clientId;
    }

    isHostByToken(roomId: string, token: string): boolean {
        const room = this.rooms.get(roomId);
        if (!room) return false;
        const user = room.tokenMap.get(token);
        return user?.isHost || false;
    }

    getOldestConnectedUser(roomId: string): { token: string; user: DiscordUser } | null {
        const room = this.rooms.get(roomId);
        if (!room) return null;

        let oldest: { token: string; user: DiscordUser } | null = null;

        for (const [token, user] of room.tokenMap) {
            if (!user.connected || user.isHost) continue;
            if (!oldest || user.connectedAt < oldest.user.connectedAt) {
                oldest = { token, user };
            }
        }

        return oldest;
    }

    isHostInactive(roomId: string): boolean {
        const room = this.rooms.get(roomId);
        if (!room) return false;
        if (room.state.isUploading) return false;

        const hostInactive = Date.now() - room.state.hostLastHeartbeat > HOST_INACTIVE_TIMEOUT;
        return hostInactive;
    }

    transferHost(roomId: string): { newHostId: string; newHostUsername: string; token: string } | null {
        const room = this.rooms.get(roomId);
        if (!room || !room.discordSession) return null;

        const oldest = this.getOldestConnectedUser(roomId);
        if (!oldest) return null;

        for (const user of room.tokenMap.values()) {
            user.isHost = false;
        }

        oldest.user.isHost = true;
        room.discordSession.hostDiscordId = oldest.user.discordId;
        room.state.hostLastHeartbeat = Date.now();

        return {
            newHostId: oldest.user.discordId,
            newHostUsername: oldest.user.username,
            token: oldest.token
        };
    }

    getCurrentTime(roomId: string): number {
        const room = this.rooms.get(roomId);
        if (!room) return 0;

        if (room.state.isPlaying) {
            const elapsed = (Date.now() - room.state.lastUpdate) / 1000;
            return room.state.currentTime + elapsed;
        }

        return room.state.currentTime;
    }

    getClientCount(roomId: string): number {
        const room = this.rooms.get(roomId);
        return room ? room.clients.size : 0;
    }

    hasVideo(roomId: string): boolean {
        const room = this.rooms.get(roomId);
        return room ? room.state.videoPath !== '' : false;
    }

    setVideoPath(roomId: string, path: string): void {
        const room = this.rooms.get(roomId);
        if (room) {
            room.state.videoPath = path;
            room.state.currentTime = 0;
            room.state.isPlaying = false;
            room.state.lastUpdate = Date.now();
        }
    }

    estimateBitrate(roomId: string): number {
        const room = this.rooms.get(roomId);
        if (!room || !room.state.videoPath || !existsSync(room.state.videoPath)) {
            return DEFAULT_BITRATE_MBPS;
        }

        try {
            const stats = statSync(room.state.videoPath);
            const sizeBits = stats.size * 8;
            // Assume 2 hours (7200s) duration as fallback if we don't know it
            // Ideally, we'd store duration from metadata when upload finishes
            const durationSeconds = 7200; 
            const bitrateBps = sizeBits / durationSeconds;
            const bitrateMbps = bitrateBps / 1_000_000;
            
            // Cap at sensible limits (e.g. min 2Mbps, max 50Mbps)
            return Math.max(2, Math.min(bitrateMbps, 50));
        } catch (e) {
            logger.warn("RoomManager", `Error estimating bitrate for room ${roomId}`, e);
            return DEFAULT_BITRATE_MBPS;
        }
    }

    addClient(roomId: string, ws: ExtendedWebSocket): boolean {
        const room = this.rooms.get(roomId);
        if (!room) return false;

        const existingTimer = this.cleanupTimers.get(roomId);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.cleanupTimers.delete(roomId);
        }

        // 1. Check User Limit
        if (room.clients.size >= MAX_CLIENTS_PER_ROOM) {
            logger.warn("RoomManager", `Connection rejected: Room ${roomId} full (${room.clients.size}/${MAX_CLIENTS_PER_ROOM})`);
            return false;
        }

        // 2. Check Bandwidth Limit
        const estimatedBitrate = this.estimateBitrate(roomId);
        const currentBandwidth = room.clients.size * estimatedBitrate;
        
        if (currentBandwidth + estimatedBitrate > MAX_BANDWIDTH_MBPS) {
            logger.warn("RoomManager", `Connection rejected: Bandwidth limit exceeded for room ${roomId}. Estimated usage: ${currentBandwidth.toFixed(1)} + ${estimatedBitrate.toFixed(1)} > ${MAX_BANDWIDTH_MBPS} Mbps`);
            return false;
        }

        room.clients.add(ws);
        logger.debug("Room", `Cliente conectado. Room: ${roomId}, Total: ${room.clients.size}, Est. Bandwidth: ${(currentBandwidth + estimatedBitrate).toFixed(1)} Mbps`);
        this.broadcastViewerCountDebounced(roomId);
        return true;
    }

    removeClient(roomId: string, ws: ExtendedWebSocket): void {
        const room = this.rooms.get(roomId);
        if (!room) return;
        room.clients.delete(ws);
        logger.debug("Room", `Cliente desconectado. Room: ${roomId}, Total: ${room.clients.size}`);

        if (ws.data.token) {
            const stillConnected = Array.from(room.clients).some(
                client => client.data.token === ws.data.token
            );
            if (!stillConnected) {
                this.markUserDisconnected(roomId, ws.data.token);
            }
        }

        if (room.clients.size === 0) {
            this.scheduleRoomCleanup(roomId);
        } else {
            this.broadcastViewerCountDebounced(roomId);
        }
    }

    private scheduleRoomCleanup(roomId: string): void {
        const existing = this.cleanupTimers.get(roomId);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
            const room = this.rooms.get(roomId);
            if (room && room.clients.size === 0) {
                this.deleteRoom(roomId);
            }
            this.cleanupTimers.delete(roomId);
        }, 30000);

        this.cleanupTimers.set(roomId, timer);
    }

    public async deleteRoom(roomId: string): Promise<void> {
        const room = this.rooms.get(roomId);
        if (!room) return;
        logger.info("RoomManager", `Removendo sala: ${roomId}`);

        for (const client of room.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.close(1000, "Sala encerrada");
            }
        }
        room.clients.clear();

        if (room.state.videoPath && existsSync(room.state.videoPath)) {
            const resolvedVideoPath = resolve(room.state.videoPath);
            const resolvedUploadsDir = resolve(UPLOADS_DIR);

            if (resolvedVideoPath.startsWith(resolvedUploadsDir)) {
                try {
                    logger.debug("RoomManager", `Deleting video file: ${room.state.videoPath}`);
                    await rm(room.state.videoPath, { force: true });
                } catch (e) {
                    logger.error("RoomManager", "Error deleting video file", e);
                }
            } else {
                logger.warn("RoomManager", `Skipping file deletion (external file): ${room.state.videoPath}`);
            }
        }

        if (this.activeDiscordSession === roomId) {
            this.activeDiscordSession = null;
        }

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

    updateState(roomId: string, updates: Partial<RoomState>): void {
        const room = this.rooms.get(roomId);
        if (!room) return;
        Object.assign(room.state, updates);
        room.state.lastUpdate = Date.now();
    }

    updateHostHeartbeat(roomId: string): void {
        const room = this.rooms.get(roomId);
        if (!room) return;
        room.state.hostLastHeartbeat = Date.now();
    }

    setLastCommandSeq(roomId: string, seq: number): void {
        const room = this.rooms.get(roomId);
        if (!room) return;
        room.state.lastCommandSeq = seq;
    }

    getLastCommandSeq(roomId: string): number {
        const room = this.rooms.get(roomId);
        return room?.state.lastCommandSeq || 0;
    }

    forEachRoom(callback: (room: Room) => void): void {
        for (const room of this.rooms.values()) {
            callback(room);
        }
    }

    getSyncInterval(roomId: string): number {
        const room = this.rooms.get(roomId);
        if (!room) return 5000;
        return room.state.isPlaying ? 2000 : 5000;
    }

    broadcast(roomId: string, message: WSMessage | string, exclude?: ExtendedWebSocket): void {
        const room = this.rooms.get(roomId);
        if (!room) return;
        
        const data = typeof message === 'string' ? message : JSON.stringify(message);
        
        for (const client of room.clients) {
            if (client !== exclude && client.readyState === WebSocket.OPEN) {
                try {
                    client.send(data);
                } catch (e) {
                    logger.error("RoomManager", "Failed to send to client", e);
                }
            }
        }
    }

    broadcastAll(roomId: string, message: WSMessage | string): void {
        const room = this.rooms.get(roomId);
        if (!room) return;
        
        const data = typeof message === 'string' ? message : JSON.stringify(message);
        
        for (const client of room.clients) {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(data);
                } catch (e) {
                    logger.error("RoomManager", "Failed to send to client", e);
                }
            }
        }
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
        if (!room) return;
        const connectedUsers = this.getConnectedUsers(roomId);
        const message = JSON.stringify({
            type: "viewers",
            count: connectedUsers.length,
            viewers: connectedUsers.map(u => ({
                discordId: u.discordId,
                username: u.username,
                ping: u.ping
            }))
        });
        for (const client of room.clients) {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(message);
                } catch (e) {
                    logger.error("RoomManager", "Failed to send viewer count", e);
                }
            }
        }
    }


    private generateId(): string {
        return randomUUID();
    }

    private generateToken(): string {
        return randomBytes(32).toString("base64url");
    }
}

export const roomManager = new RoomManager();
