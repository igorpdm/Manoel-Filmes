import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage, Server } from "http";
import { parse as parseCookieHeader } from "cookie";
import type { ExtendedWebSocket } from "../shared/types";
import { roomManager } from "../core/room-manager";
import { handleWebSocketMessage } from "./websocket-handler";
import { buildSessionStatusData } from "./services/session-status";
import { logger } from "../shared/logger";
import { decodeSession, SESSION_COOKIE_NAME } from "./http/session-middleware";

const HOST_CHECK_INTERVAL = 15000;
const HEARTBEAT_INTERVAL = 30000;
const GLOBAL_TICK_MS = 1000;
const SYNC_TICK_INTERVAL = 3000;

const roomLastSync = new Map<string, number>();

function scheduleHostCheck(wss: WebSocketServer): void {
    setInterval(() => {
        roomManager.forEachRoom(room => {
            if (!room.discordSession) return;
            if (room.clients.size === 0) return;
            if (room.status === "ended") return;

            if (roomManager.isHostInactive(room.id)) {
                const newHost = roomManager.transferHost(room.id);
                if (newHost) {
                    logger.warn("HostTransfer", `Host inativo - transferindo para ${newHost.newHostUsername}`);
                    roomManager.broadcastAll(room.id, {
                        type: "host-changed",
                        newHostId: newHost.newHostId,
                        newHostUsername: newHost.newHostUsername,
                    });
                }
            }
        });
    }, HOST_CHECK_INTERVAL);
}

function scheduleSyncTick(): void {
    setInterval(() => {
        const serverTime = Date.now();
        roomManager.forEachRoom(room => {
            if (room.clients.size === 0) return;

            const lastSync = roomLastSync.get(room.id) ?? 0;
            const interval = roomManager.getSyncInterval(room.id);

            if (serverTime - lastSync < interval) return;
            if (!room.state.playbackStarted) return;

            roomLastSync.set(room.id, serverTime);

            if (room.state.isPlaying || (serverTime - lastSync > 5000)) {
                const currentTime = roomManager.getCurrentTime(room.id);
                roomManager.broadcastAll(room.id, {
                    type: "sync",
                    currentTime,
                    isPlaying: room.state.isPlaying,
                    serverTime,
                });
            }
        });
    }, GLOBAL_TICK_MS);
}

function scheduleHeartbeat(wss: WebSocketServer): void {
    setInterval(() => {
        wss.clients.forEach((ws) => {
            const extWs = ws as ExtendedWebSocket;
            if (extWs.isAlive === false) {
                ws.terminate();
                return;
            }
            extWs.isAlive = false;
            ws.ping();
        });
    }, HEARTBEAT_INTERVAL);
}

function sendInitialState(ws: ExtendedWebSocket, roomId: string, isHost: boolean): void {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    const currentTime = roomManager.getCurrentTime(roomId);
    ws.send(JSON.stringify({ type: "sync", currentTime, isPlaying: room.state.isPlaying, isHost }));

    if (room.state.isUploading) {
        ws.send(JSON.stringify({ type: "upload-progress", progress: room.state.uploadProgress }));
    }

    if (room.state.isAwaitingAudioSelection) {
        ws.send(JSON.stringify({
            type: "audio-track-selection-required",
            audioTracks: room.state.audioTracks,
            errorMessage: room.state.audioSelectionErrorMessage || "",
        }));
    }

    if (room.state.isProcessing) {
        ws.send(JSON.stringify({ type: "processing-progress", processingMessage: room.state.processingMessage }));
    }

    const statusData = buildSessionStatusData(roomManager, roomId);
    if (statusData) {
        ws.send(JSON.stringify({ type: "session-status", ...statusData }));
    }

    const ratingProgress = roomManager.getRatingProgress(roomId);
    if (ratingProgress) {
        ws.send(JSON.stringify({
            type: "rating-progress",
            ratingProgress,
        }));

        if (ratingProgress.isClosed) {
            ws.send(JSON.stringify({
                type: "all-ratings-received",
                ratings: ratingProgress.ratings,
                average: ratingProgress.average,
                allRated: true,
                completionReason: ratingProgress.completionReason,
                ratingProgress,
            }));
        }
    }
}

function getRoomTokenFromUpgradeHeader(request: IncomingMessage): string {
    const roomHeader = request.headers["x-room-token"];
    return typeof roomHeader === "string" ? roomHeader.trim() : "";
}

function isAllowedUpgradeOrigin(request: IncomingMessage, hasHeaderToken: boolean): boolean {
    const origin = request.headers.origin;
    if (!origin) {
        return hasHeaderToken;
    }

    const host = request.headers.host;
    if (!host) {
        return false;
    }

    const forwardedProto = request.headers["x-forwarded-proto"];
    const protocol = typeof forwardedProto === "string"
        ? forwardedProto.split(",")[0].trim()
        : ((request.socket as { encrypted?: boolean }).encrypted ? "https" : "http");

    try {
        const parsedOrigin = new URL(origin);
        return parsedOrigin.origin === `${protocol}://${host}`;
    } catch {
        return false;
    }
}

function resolveUpgradeAuthentication(
    request: IncomingMessage,
    roomId: string
): { token: string; discordUser: NonNullable<ExtendedWebSocket["data"]["discordUser"]> } | null {
    const headerToken = getRoomTokenFromUpgradeHeader(request);
    if (headerToken) {
        const headerUser = roomManager.validateToken(roomId, headerToken);
        return headerUser ? { token: headerToken, discordUser: headerUser } : null;
    }

    const cookieHeader = request.headers.cookie;
    if (typeof cookieHeader !== "string" || !cookieHeader.trim()) {
        return null;
    }

    const cookies = parseCookieHeader(cookieHeader);
    const sessionCookie = cookies[SESSION_COOKIE_NAME];
    const oauthSession = sessionCookie ? decodeSession(sessionCookie) : null;
    if (!oauthSession) {
        return null;
    }

    const authorized = roomManager.findAuthorizedUserByDiscordId(roomId, oauthSession.discordId);
    if (!authorized) {
        return null;
    }

    return {
        token: authorized.token,
        discordUser: authorized.user,
    };
}

/**
 * Inicializa o servidor WebSocket e todos os ticks de sincronização.
 * @param wss Instância do WebSocketServer.
 * @param server Servidor HTTP para o upgrade handler.
 */
export function setupWebSocketServer(wss: WebSocketServer, server: Server): void {
    server.on("upgrade", (request: IncomingMessage, socket, head) => {
        const url = new URL(request.url || "", `http://${request.headers.host}`);
        if (url.pathname !== "/ws") {
            socket.destroy();
            return;
        }

        const roomId = url.searchParams.get("room");
        const clientId = url.searchParams.get("clientId") || "";
        const hasHeaderToken = Boolean(getRoomTokenFromUpgradeHeader(request));

        if (!roomId) {
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.destroy();
            return;
        }

        if (!isAllowedUpgradeOrigin(request, hasHeaderToken)) {
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
            return;
        }

        const room = roomManager.getRoom(roomId);
        if (!room || !room.discordSession) {
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.destroy();
            return;
        }

        const auth = resolveUpgradeAuthentication(request, roomId);
        if (!auth) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
            const extWs = ws as ExtendedWebSocket;
            extWs.data = { roomId, clientId, token: auth.token, discordUser: auth.discordUser };
            wss.emit("connection", extWs, request);
        });
    });

    wss.on("connection", (ws: ExtendedWebSocket) => {
        const { roomId, clientId, token } = ws.data;
        logger.info("WS", `Conexão aberta: room=${roomId} client=${clientId} token=${token ? "sim" : "não"}`);

        if (!token) {
            logger.warn("WS", `Conexão sem token após upgrade: room=${roomId} client=${clientId}`);
            ws.close(4001, "Missing token");
            return;
        }

        ws.isAlive = true;
        ws.on("pong", () => { ws.isAlive = true; });

        roomManager.markUserConnected(roomId, token);
        const isHost = roomManager.isHostByToken(roomId, token);

        const added = roomManager.addClient(roomId, ws);
        if (!added) {
            logger.warn("WS", `Conexão rejeitada (Sala cheia ou limite de banda): room=${roomId}`);
            ws.close(4003, "Room full or bandwidth limit exceeded");
            return;
        }

        if (isHost) roomManager.updateHostHeartbeat(roomId);

        sendInitialState(ws, roomId, isHost);

        ws.on("message", (message) => handleWebSocketMessage(ws, message));

        ws.on("close", () => {
            logger.info("WS", `Conexão fechada: room=${roomId}`);
            roomManager.removeClient(roomId, ws);
        });
    });

    scheduleHostCheck(wss);
    scheduleSyncTick();
    scheduleHeartbeat(wss);
}
