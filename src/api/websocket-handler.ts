import type { WSMessage, ExtendedWebSocket } from "../shared/types";
import { roomManager } from "../core/room-manager";
import { logger } from "../shared/logger";
import { buildSessionStatusData } from "./services/session-status";

function isCommandSeqValid(roomId: string, seq?: number) {
    if (typeof seq !== "number") return true;
    const lastSeq = roomManager.getLastCommandSeq(roomId);
    return seq > lastSeq;
}

export function handleWebSocketMessage(ws: ExtendedWebSocket, message: any) {
    const { roomId, clientId, token } = ws.data;
    let data: WSMessage;
    try {
        data = JSON.parse(message.toString()) as WSMessage;
    } catch {
        return;
    }

    const serverTime = Date.now();

    // Filter spammy logs
    if (data.type !== "ping" && 
        data.type !== "pong" && 
        data.type !== "update-metrics" && 
        data.type !== "host-heartbeat" && 
        data.type !== "state" &&
        data.type !== "session-status") {
        logger.info("WS", `Comando: ${data.type} (Client: ${clientId}, Room: ${roomId})`);
    } else {
        // Log heartbeat/metrics only in debug mode
        logger.debug("WS", `Heartbeat/Sync: ${data.type} (Room: ${roomId})`);
    }

    const isHost = token
        ? roomManager.isHostByToken(roomId, token)
        : roomManager.isHost(roomId, clientId);

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

        case "play":
            if (!isHost) break;
            if (!isCommandSeqValid(roomId, data.seq)) break;

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

        case "state":
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
