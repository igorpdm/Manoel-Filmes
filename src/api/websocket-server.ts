import { parse as parseCookieHeader } from "cookie";
import type { ClientData, ExtendedWebSocket } from "../shared/types";
import { roomManager } from "../core/room-manager";
import { handleWebSocketMessage } from "./websocket-handler";
import { buildSessionStatusData } from "./services/session-status";
import { logger } from "../shared/logger";
import { decodeSession, SESSION_COOKIE_NAME } from "./http/session-middleware";
import { getServiceSecretFromHeaders, isTrustedServiceSecret } from "./http/service-auth";

const HOST_CHECK_INTERVAL = 15000;
const HEARTBEAT_INTERVAL = 30000;
const GLOBAL_TICK_MS = 1000;

const roomLastSync = new Map<string, number>();
const activeSockets = new Set<ExtendedWebSocket>();

let didStartIntervals = false;

function scheduleHostCheck(): void {
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

function scheduleHeartbeat(): void {
    setInterval(() => {
        for (const ws of activeSockets) {
            if (ws.data.isAlive === false) {
                closeDeadSocket(ws);
                continue;
            }

            ws.data.isAlive = false;
            try {
                ws.ping();
            } catch {
                closeDeadSocket(ws);
            }
        }
    }, HEARTBEAT_INTERVAL);
}

function closeDeadSocket(ws: ExtendedWebSocket): void {
    try {
        const terminable = ws as ExtendedWebSocket & { terminate?: () => void };
        if (terminable.terminate) {
            terminable.terminate();
            return;
        }
        ws.close();
    } catch {
        activeSockets.delete(ws);
    }
}

function sendSessionSnapshot(ws: ExtendedWebSocket, roomId: string): void {
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

function sendInitialState(ws: ExtendedWebSocket, roomId: string, isHost: boolean): void {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    const currentTime = roomManager.getCurrentTime(roomId);
    ws.send(JSON.stringify({ type: "sync", currentTime, isPlaying: room.state.isPlaying, isHost }));

    if (room.state.isUploading) {
        if (isHost) {
            ws.send(JSON.stringify({ type: "upload-reconnect", progress: room.state.uploadProgress }));
        } else {
            ws.send(JSON.stringify({ type: "upload-progress", progress: room.state.uploadProgress }));
        }
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

    sendSessionSnapshot(ws, roomId);
}

function getRoomTokenFromUpgradeHeader(request: Request): string {
    return request.headers.get("x-room-token")?.trim() || "";
}

function isAllowedUpgradeOrigin(request: Request, hasTrustedHeaderAuth: boolean): boolean {
    const origin = request.headers.get("origin");
    if (!origin) {
        return hasTrustedHeaderAuth;
    }

    const host = request.headers.get("host");
    if (!host) {
        return false;
    }

    const forwardedProto = request.headers.get("x-forwarded-proto");
    const protocol = forwardedProto
        ? forwardedProto.split(",")[0].trim()
        : new URL(request.url).protocol.replace(":", "");

    try {
        const parsedOrigin = new URL(origin);
        return parsedOrigin.origin === `${protocol}://${host}`;
    } catch {
        return false;
    }
}

type UpgradeAuthenticationResult =
    | { isServiceObserver: true; token?: undefined; discordUser?: undefined }
    | { isServiceObserver: false; token: string; discordUser: NonNullable<ClientData["discordUser"]> };

function resolveUpgradeAuthentication(
    request: Request,
    roomId: string
): UpgradeAuthenticationResult | null {
    const serviceSecret = getServiceSecretFromHeaders(request.headers);
    if (serviceSecret) {
        return isTrustedServiceSecret(serviceSecret) ? { isServiceObserver: true } : null;
    }

    const headerToken = getRoomTokenFromUpgradeHeader(request);
    if (headerToken) {
        const headerUser = roomManager.validateToken(roomId, headerToken);
        return headerUser ? { isServiceObserver: false, token: headerToken, discordUser: headerUser } : null;
    }

    const cookieHeader = request.headers.get("cookie");
    if (!cookieHeader?.trim()) {
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
        isServiceObserver: false,
        token: authorized.token,
        discordUser: authorized.user,
    };
}

/**
 * Inicializa os ticks globais do WebSocket nativo do Bun.
 */
export function setupWebSocketServer(): void {
    if (didStartIntervals) return;

    didStartIntervals = true;
    scheduleHostCheck();
    scheduleSyncTick();
    scheduleHeartbeat();
}

/**
 * Processa upgrades WebSocket para a rota /ws usando Bun.serve.
 * @param request Request HTTP original.
 * @param server Servidor Bun responsável pelo upgrade.
 * @returns null quando não é WebSocket; Response para rejeição; undefined quando o upgrade foi aceito.
 */
export function handleWebSocketUpgrade(request: Request, server: Bun.Server<ClientData>): Response | undefined | null {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") {
        return null;
    }

    const roomId = url.searchParams.get("room");
    const clientId = url.searchParams.get("clientId") || "";
    const hasTrustedHeaderAuth = Boolean(
        getRoomTokenFromUpgradeHeader(request) || getServiceSecretFromHeaders(request.headers)
    );

    if (!roomId) {
        return new Response("Not Found", { status: 404 });
    }

    if (!isAllowedUpgradeOrigin(request, hasTrustedHeaderAuth)) {
        return new Response("Forbidden", { status: 403 });
    }

    const room = roomManager.getRoom(roomId);
    if (!room || !room.discordSession) {
        return new Response("Not Found", { status: 404 });
    }

    const auth = resolveUpgradeAuthentication(request, roomId);
    if (!auth) {
        return new Response("Unauthorized", { status: 401 });
    }

    const didUpgrade = server.upgrade(request, {
        data: {
            roomId,
            clientId,
            token: auth.token,
            discordUser: auth.discordUser,
            isAlive: true,
            isServiceObserver: auth.isServiceObserver,
        },
    });

    return didUpgrade ? undefined : new Response("Upgrade failed", { status: 500 });
}

export const websocketHandlers: Bun.WebSocketHandler<ClientData> = {
    open(ws) {
        const extWs = ws as ExtendedWebSocket;
        const { roomId, clientId, token, isServiceObserver } = extWs.data;

        if (isServiceObserver) {
            logger.info("WS", `Observador conectado: room=${roomId} client=${clientId}`);
            extWs.data.isAlive = true;
            activeSockets.add(extWs);

            if (!roomManager.addObserver(roomId, extWs)) {
                activeSockets.delete(extWs);
                logger.warn("WS", `Conexão de observador rejeitada (sala inexistente): room=${roomId}`);
                extWs.close(4004, "Room not found");
                return;
            }

            sendSessionSnapshot(extWs, roomId);
            return;
        }

        logger.info("WS", `Conexão aberta: room=${roomId} client=${clientId} token=${token ? "sim" : "não"}`);

        if (!token) {
            logger.warn("WS", `Conexão sem token após upgrade: room=${roomId} client=${clientId}`);
            extWs.close(4001, "Missing token");
            return;
        }

        extWs.data.isAlive = true;
        activeSockets.add(extWs);

        roomManager.markUserConnected(roomId, token);
        const isHost = roomManager.isHostByToken(roomId, token);

        const added = roomManager.addClient(roomId, extWs);
        if (!added) {
            activeSockets.delete(extWs);
            logger.warn("WS", `Conexão rejeitada (Sala cheia ou limite de banda): room=${roomId}`);
            extWs.close(4003, "Room full or bandwidth limit exceeded");
            return;
        }

        if (isHost) roomManager.updateHostHeartbeat(roomId);
        sendInitialState(extWs, roomId, isHost);
    },

    message(ws, message) {
        const extWs = ws as ExtendedWebSocket;
        extWs.data.isAlive = true;
        handleWebSocketMessage(extWs, message);
    },

    close(ws) {
        const extWs = ws as ExtendedWebSocket;
        const { roomId, isServiceObserver } = extWs.data;
        logger.info("WS", `Conexão fechada: room=${roomId}`);
        activeSockets.delete(extWs);
        if (isServiceObserver) {
            roomManager.removeObserver(roomId, extWs);
            return;
        }
        roomManager.removeClient(roomId, extWs);
    },

    pong(ws) {
        ws.data.isAlive = true;
    },
};

export function closeAllWebSockets(): void {
    for (const ws of activeSockets) {
        try {
            ws.close(1001, "Server shutting down");
        } catch (error) {
            logger.error("Server", "Error closing WebSocket:", error);
        }
    }
    activeSockets.clear();
}
