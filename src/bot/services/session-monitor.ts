import { TextChannel } from "discord.js";
import { activeWatchSession, setActiveWatchSession, ActiveWatchSession } from "../state";
import * as playerApi from "./player-api";
import { buildSessionEmbed } from "../ui/embeds";
import { buildSessionComponents } from "../ui/components";
import db from "../../database";

const SESSION_CHECK_INTERVAL = 5000;
const RECONNECT_DELAY = 2000;
const MAX_SESSION_DURATION = 4 * 60 * 60 * 1000; // 4 hours

let monitorSocket: WebSocket | null = null;
let monitorRoomId: string | null = null;
let checkInterval: NodeJS.Timeout | null = null;
let reconnectTimeout: NodeJS.Timeout | null = null;
let lastStatus: "waiting" | "playing" | "ended" = "waiting";
let lastViewerIds: Set<string> = new Set();
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

export const startSessionMonitor = (client: any) => {
    if (checkInterval) clearInterval(checkInterval);

    checkInterval = setInterval(() => {
        const session = activeWatchSession;

        if (!session) {
            resetMonitorState();
            closeSocket();
            return;
        }

        // Safety check: Kill monitoring if session is too old (Zombie session)
        if (Date.now() - session.createdAt > MAX_SESSION_DURATION) {
            console.warn(`[SessionMonitor] Sessão expirada por tempo limite (${session.roomId}). Parando monitoramento.`);
            setActiveWatchSession(null);
            resetMonitorState();
            closeSocket();
            return;
        }

        if (!monitorSocket || monitorSocket.readyState === WebSocket.CLOSED || monitorRoomId !== session.roomId) {
            console.log(`[SessionMonitor] Conectando ao WS: room=${session.roomId}`);
            connectToSession(client, session);
        }
    }, SESSION_CHECK_INTERVAL);
};

function resetMonitorState() {
    lastStatus = "waiting";
    lastViewerIds = new Set();
    monitorRoomId = null;
    reconnectAttempts = 0;
}

let finalizing = false;

function closeSocket() {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    if (monitorSocket) {
        monitorSocket.onclose = null;
        monitorSocket.onerror = null;
        monitorSocket.onmessage = null;
        monitorSocket.onopen = null;
        monitorSocket.close();
        monitorSocket = null;
    }
}

function connectToSession(client: any, session: ActiveWatchSession) {
    closeSocket();
    monitorRoomId = session.roomId;
    finalizing = false;

    const wsUrl = buildWsUrl(session.roomId, session.hostToken);
    monitorSocket = new WebSocket(wsUrl);

    monitorSocket.onopen = () => {
        console.log(`[SessionMonitor] WS aberto: room=${session.roomId}`);
        reconnectAttempts = 0;
        try {
            monitorSocket?.send(JSON.stringify({ type: "session-status" }));
        } catch {
            monitorSocket?.close();
        }
    };

    monitorSocket.onmessage = async (event) => {
        const currentSession = activeWatchSession;
        if (!currentSession || currentSession.roomId !== session.roomId) return;

        let data: any = null;
        try {
            data = JSON.parse(event.data);
        } catch {
            return;
        }

        if (!data?.type) return;

        switch (data.type) {
            case "viewers":
                await handleViewersUpdate(client, currentSession, data);
                break;
            case "session-status":
                await handleSessionStatus(client, currentSession, data);
                break;
            case "session-ending":
            case "session-ended":
                requestSessionStatus();
                break;
            case "all-ratings-received":
                await handleAllRatingsReceived(client, currentSession, data);
                break;
        }
    };

    monitorSocket.onclose = () => {
        console.log(`[SessionMonitor] WS fechado: room=${session.roomId}`);
        monitorSocket = null;
        scheduleReconnect(client);
    };

    monitorSocket.onerror = () => {
        console.log(`[SessionMonitor] WS erro: room=${session.roomId}`);
        monitorSocket?.close();
    };
}

function buildWsUrl(roomId: string, token: string) {
    const baseUrl = playerApi.getPlayerUrl();
    const wsBase = baseUrl.startsWith("https://")
        ? baseUrl.replace("https://", "wss://")
        : baseUrl.replace("http://", "ws://");
    const clientId = `bot-${Math.random().toString(36).slice(2, 10)}`;
    return `${wsBase}/ws?room=${roomId}&clientId=${clientId}&token=${token}`;
}

function scheduleReconnect(client: any) {
    if (!activeWatchSession || monitorRoomId !== activeWatchSession.roomId) return;
    if (reconnectTimeout) return;
    if (monitorSocket && monitorSocket.readyState === WebSocket.OPEN) return;

    const delay = Math.min(RECONNECT_DELAY * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
    reconnectAttempts++;
    console.log(`[SessionMonitor] Reconectando em ${delay}ms (tentativa ${reconnectAttempts})`);

    reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        if (activeWatchSession) {
            connectToSession(client, activeWatchSession);
        }
    }, delay);
}

function requestSessionStatus() {
    if (!monitorSocket || monitorSocket.readyState !== WebSocket.OPEN) return;
    monitorSocket.send(JSON.stringify({ type: "session-status" }));
}

async function handleViewersUpdate(client: any, session: ActiveWatchSession, data: any) {
    const viewers: { discordId: string; username: string }[] = data.viewers || [];
    const currentIds = new Set(viewers.map(v => v.discordId));

    const hasChanges = currentIds.size !== lastViewerIds.size ||
        [...currentIds].some(id => !lastViewerIds.has(id));

    if (hasChanges && lastStatus === "playing") {
        lastViewerIds = currentIds;
        await updateSessionEmbed(client, session, "playing", viewers.length, viewers);
    } else {
        lastViewerIds = currentIds;
    }
}

async function handleSessionStatus(client: any, session: ActiveWatchSession, data: any) {
    const currentStatus = data.status || "waiting";
    const viewerCount = data.viewerCount ?? data.count ?? 0;
    const viewers = data.viewers || [];
    const ratings = data.ratings || [];
    const currentIds = new Set<string>(viewers.map((v: any) => v.discordId));

    const statusChanged = lastStatus !== currentStatus;
    const viewersChanged = currentIds.size !== lastViewerIds.size ||
        [...currentIds].some(id => !lastViewerIds.has(id));

    lastStatus = currentStatus;
    lastViewerIds = currentIds;

    if (statusChanged) {
        await updateSessionEmbed(client, session, currentStatus, viewerCount, viewers, ratings);
    } else if (currentStatus === "playing" && viewersChanged) {
        await updateSessionEmbed(client, session, "playing", viewerCount, viewers);
    }

    if (currentStatus === "ended" && data.allRated) {
        await finalizeSession(session, ratings);
    }
}

async function handleAllRatingsReceived(client: any, session: ActiveWatchSession, data: any) {
    const ratings = data.ratings || [];

    if (lastStatus !== "ended") {
        lastStatus = "ended";
    }

    await updateSessionEmbed(client, session, "ended", lastViewerIds.size, [], ratings);
    await finalizeSession(session, ratings);
}

async function finalizeSession(session: ActiveWatchSession, ratings: any[]) {
    if (finalizing) return;
    finalizing = true;

    try {
        console.log(`[SessionMonitor] Finalizando sessão: room=${session.roomId} ratings=${ratings.length}`);
        await db.registerMovieStart(session.movieName, session.tmdbInfo);

        if (session.tmdbInfo?.title) {
            await db.removeFromWatchlistByTitle(session.tmdbInfo.title);
        }

        if (session.movieName && session.movieName !== session.tmdbInfo?.title) {
            await db.removeFromWatchlistByTitle(session.movieName);
        }

        for (const r of ratings) {
            await db.addVote(session.movieName, r.discordId, r.username, r.rating);
        }

        await playerApi.finalizeSession(session.roomId, session.hostToken);
    } catch (dbError) {
        console.error("[SessionMonitor] Failed to persist session data:", dbError);
    }

    setActiveWatchSession(null);
}

async function updateSessionEmbed(
    client: any,
    session: ActiveWatchSession,
    status: "playing" | "waiting" | "ended",
    viewerCount: number = 0,
    viewers: any[] = [],
    ratings: any[] = []
) {
    try {
        const channel = await client.channels.fetch(session.channelId) as TextChannel;
        if (!channel) return;

        const message = await channel.messages.fetch(session.messageId);
        if (!message) return;

        const embed = buildSessionEmbed(
            session.movieName,
            session.tmdbInfo,
            status,
            session.hostUsername,
            viewerCount,
            ratings.map(r => ({ ...r, discordId: r.discordId || '', username: r.username || 'User' })),
            session.selectedEpisode,
            session.createdAt
        );

        const components = status === "ended" ? [] : buildSessionComponents(session.roomId, status);

        await message.edit({
            embeds: [embed],
            components
        });

    } catch (error) {
        console.error("[SessionMonitor] Failed to update Discord message:", error);
    }
}
