import type { UploadDeps, UploadMeta } from "./upload-types";

const PROGRESS_BROADCAST_THROTTLE_MS = 250;

const progressBroadcastByRoom = new Map<string, { progress: number; lastSent: number }>();

export function computeUploadProgress(meta: UploadMeta, receivedSet: Set<number> | undefined): number {
    if (!meta.totalChunks) return 0;
    const received = receivedSet?.size || 0;
    return Math.min(99, Math.round((received / meta.totalChunks) * 100));
}

export function maybeBroadcastUploadProgress(roomId: string, deps: UploadDeps, progress: number, force = false): void {
    const now = Date.now();
    const prev = progressBroadcastByRoom.get(roomId);
    const previousProgress = prev?.progress;

    if (!prev) {
        progressBroadcastByRoom.set(roomId, { progress, lastSent: 0 });
    } else {
        prev.progress = progress;
    }

    const state = progressBroadcastByRoom.get(roomId)!;

    if (!force) {
        if (now - state.lastSent < PROGRESS_BROADCAST_THROTTLE_MS) return;
        if (previousProgress === progress && state.lastSent > 0) return;
    }

    state.lastSent = now;
    deps.roomManager.broadcastAll(roomId, { type: "upload-progress", progress });
}
