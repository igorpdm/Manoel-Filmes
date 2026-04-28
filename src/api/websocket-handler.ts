import type { WSMessage, ExtendedWebSocket } from "../shared/types";
import { roomManager } from "../core/room-manager";
import { logger } from "../shared/logger";
import { buildSessionStatusData } from "./services/session-status";

const allowedClientMessageTypes = new Set([
    "host-heartbeat",
    "ping",
    "play",
    "pause",
    "seek",
    "state",
    "session-status",
    "update-metrics",
]);

function isFiniteNonNegativeNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseClientMessage(message: unknown): WSMessage | null {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
        return null;
    }

    const data = message as Record<string, unknown>;
    if (typeof data.type !== "string" || !allowedClientMessageTypes.has(data.type)) {
        return null;
    }

    if (data.currentTime !== undefined && !isFiniteNonNegativeNumber(data.currentTime)) {
        return null;
    }

    if (data.timestamp !== undefined && !isFiniteNonNegativeNumber(data.timestamp)) {
        return null;
    }

    if (data.seq !== undefined && (!Number.isInteger(data.seq) || (data.seq as number) < 0)) {
        return null;
    }

    if (data.metrics !== undefined) {
        if (!data.metrics || typeof data.metrics !== "object" || Array.isArray(data.metrics)) {
            return null;
        }

        const metrics = data.metrics as Record<string, unknown>;
        if (metrics.lastPing !== undefined && !isFiniteNonNegativeNumber(metrics.lastPing)) {
            return null;
        }
    }

    return data as unknown as WSMessage;
}

function isCommandSeqValid(roomId: string, seq?: number): boolean {
    if (typeof seq !== "number") return true;
    const lastSeq = roomManager.getLastCommandSeq(roomId);
    return seq > lastSeq;
}

function toMessageText(message: unknown): string {
    if (typeof message === "string") return message;
    if (message instanceof ArrayBuffer) return Buffer.from(message).toString("utf8");
    if (ArrayBuffer.isView(message)) return Buffer.from(message.buffer, message.byteOffset, message.byteLength).toString("utf8");
    return String(message);
}

export function handleWebSocketMessage(ws: ExtendedWebSocket, message: any) {
    const { roomId, clientId, token } = ws.data;
    let data: WSMessage;
    try {
        const parsed = parseClientMessage(JSON.parse(toMessageText(message)));
        if (!parsed) {
            logger.warn("WS", `Payload inválido descartado: room=${roomId} client=${clientId}`);
            return;
        }

        data = parsed;
    } catch {
        return;
    }

    const serverTime = Date.now();

    const isVerboseType = data.type === "ping" ||
        data.type === "pong" ||
        data.type === "update-metrics" ||
        data.type === "host-heartbeat" ||
        data.type === "state" ||
        data.type === "session-status";

    if (isVerboseType) {
        logger.debug("WS", `Heartbeat/Sync: ${data.type} (Room: ${roomId})`);
    } else {
        logger.info("WS", `Comando: ${data.type} (Client: ${clientId}, Room: ${roomId})`);
    }

    const isHost = token ? roomManager.isHostByToken(roomId, token) : false;

    switch (data.type) {
        case "session-status":
            const statusData = buildSessionStatusData(roomManager, roomId);
            if (statusData) {
                ws.send(JSON.stringify({ type: "session-status", ...statusData }));
            }
            break;
        case "host-heartbeat":
            if (isHost) {
                roomManager.updateHostHeartbeat(roomId);
            }
            break;
        case "ping":
            ws.send(JSON.stringify({
                type: "pong",
                timestamp: data.timestamp,
                serverTime
            }));
            break;

        case "play": {
            if (!isHost) break;
            if (!isCommandSeqValid(roomId, data.seq)) break;
            if (!isFiniteNonNegativeNumber(data.currentTime)) break;

            roomManager.updateHostHeartbeat(roomId);
            logger.info("WS", `▶️ Play: Room ${roomId} at ${data.currentTime}s`);

            const playRoom = roomManager.getRoom(roomId);
            const isFirstPlay = playRoom && !playRoom.state.playbackStarted;

            roomManager.updateState(roomId, {
                isPlaying: true,
                currentTime: data.currentTime,
                lastUpdate: serverTime,
                playbackStarted: true
            });

            if (isFirstPlay && playRoom?.discordSession) {
                roomManager.setSessionStatus(roomId, 'playing');

                const statusData = buildSessionStatusData(roomManager, roomId);
                if (statusData) {
                    roomManager.broadcastAll(roomId, { type: "session-status", ...statusData });
                }
            }

            roomManager.broadcastAll(roomId, {
                type: "sync",
                currentTime: data.currentTime,
                isPlaying: true,
                serverTime
            });

            if (typeof data.seq === "number") {
                roomManager.setLastCommandSeq(roomId, data.seq);
            }
            break;
        }

        case 'update-metrics':
            if (data.metrics && token) {
                const ping = data.metrics.lastPing;
                if (Number.isFinite(ping)) {
                    roomManager.updateUserMetrics(roomId, token, data.metrics);
                    roomManager.broadcastViewerCount(roomId);
                }
            }
            break;

        case "pause":
            if (!isHost) break;
            if (!isCommandSeqValid(roomId, data.seq)) break;
            if (!isFiniteNonNegativeNumber(data.currentTime)) break;

            roomManager.updateHostHeartbeat(roomId);
            logger.info("WS", `⏸️ Pause: Room ${roomId} at ${data.currentTime}s`);

            roomManager.updateState(roomId, {
                isPlaying: false,
                currentTime: data.currentTime,
                lastUpdate: serverTime
            });
            roomManager.broadcastAll(roomId, {
                type: "sync",
                currentTime: data.currentTime,
                isPlaying: false,
                serverTime
            });

            if (typeof data.seq === "number") {
                roomManager.setLastCommandSeq(roomId, data.seq);
            }
            break;

        case "seek":
            if (!isHost) break;
            if (!isCommandSeqValid(roomId, data.seq)) break;
            if (!isFiniteNonNegativeNumber(data.currentTime)) break;

            roomManager.updateHostHeartbeat(roomId);
            logger.info("WS", `⏩ Seek: Room ${roomId} to ${data.currentTime}s`);

            roomManager.updateState(roomId, {
                currentTime: data.currentTime,
                lastUpdate: serverTime
            });
            roomManager.broadcastAll(roomId, {
                type: "sync",
                currentTime: data.currentTime,
                isPlaying: roomManager.getRoom(roomId)?.state.isPlaying || false,
                serverTime
            });

            if (typeof data.seq === "number") {
                roomManager.setLastCommandSeq(roomId, data.seq);
            }
            break;

        case "state": {
            const room = roomManager.getRoom(roomId);
            if (room) {
                const currentTime = roomManager.getCurrentTime(roomId);
                ws.send(JSON.stringify({
                    type: "sync",
                    currentTime,
                    isPlaying: room.state.isPlaying,
                    serverTime
                }));
            }
            break;
        }
    }
}
