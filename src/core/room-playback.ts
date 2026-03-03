import { existsSync, statSync } from "fs";
import type { Room, RoomState } from "../shared/types";
import { logger } from "../shared/logger";

const DEFAULT_BITRATE_MBPS = 15;
const HOST_INACTIVE_TIMEOUT = 60 * 1000;

export function getCurrentTime(room: Room): number {
    if (room.state.isPlaying) {
        const elapsed = (Date.now() - room.state.lastUpdate) / 1000;
        return room.state.currentTime + elapsed;
    }
    return room.state.currentTime;
}

export function getSyncInterval(room: Room): number {
    return room.state.isPlaying ? 2000 : 5000;
}

export function isHostInactive(room: Room): boolean {
    if (room.state.isUploading) return false;
    return Date.now() - room.state.hostLastHeartbeat > HOST_INACTIVE_TIMEOUT;
}

export function hasVideo(room: Room): boolean {
    return room.state.videoPath !== '';
}

export function setVideoPath(room: Room, path: string): void {
    room.state.videoPath = path;
    room.state.pendingVideoPath = '';
    room.state.isAwaitingAudioSelection = false;
    room.state.audioTracks = [];
    room.state.selectedAudioStreamIndex = null;
    room.state.audioSelectionErrorMessage = '';
    room.state.currentTime = 0;
    room.state.isPlaying = false;
    room.state.lastUpdate = Date.now();
}

export function updateState(room: Room, updates: Partial<RoomState>): void {
    Object.assign(room.state, updates);
    room.state.lastUpdate = Date.now();
}

export function updateHostHeartbeat(room: Room): void {
    room.state.hostLastHeartbeat = Date.now();
}

export function setLastCommandSeq(room: Room, seq: number): void {
    room.state.lastCommandSeq = seq;
}

export function getLastCommandSeq(room: Room): number {
    return room.state.lastCommandSeq;
}

export function estimateBitrate(room: Room): number {
    if (!room.state.videoPath || !existsSync(room.state.videoPath)) {
        return DEFAULT_BITRATE_MBPS;
    }

    try {
        const stats = statSync(room.state.videoPath);
        // Assume duração de 2h (7200s) como fallback — idealmente usar metadados do ffprobe
        const bitrateMbps = (stats.size * 8) / 7200 / 1_000_000;
        return Math.max(2, Math.min(bitrateMbps, 50));
    } catch (e) {
        logger.warn("Room", `Erro ao estimar bitrate para sala ${room.id}`, e);
        return DEFAULT_BITRATE_MBPS;
    }
}
