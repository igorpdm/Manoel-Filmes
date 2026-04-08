import { TextChannel } from "discord.js";
import type { Client } from "discord.js";
import WebSocket from "ws";
import { activeWatchSession, setActiveWatchSession, ActiveWatchSession } from "../state";
import * as playerApi from "./player-api";
import { buildSessionEmbed } from "../ui/embeds";
import { buildSessionComponents } from "../ui/components";
import { logger } from "../../shared/logger";
import db from "../../database";
import type { SelectedEpisode, SessionRating } from "../../shared/types";

const SESSION_CHECK_INTERVAL = 5000;
const RECONNECT_DELAY = 2000;
const MAX_SESSION_DURATION = 4 * 60 * 60 * 1000;
const MAX_RECONNECT_DELAY = 30000;

interface WsViewersPayload {
    viewers: { discordId: string; username: string }[];
}

interface WsSessionStatusPayload {
    status: "waiting" | "playing" | "ended";
    viewerCount?: number;
    count?: number;
    viewers: { discordId: string; username: string }[];
    ratings: SessionRatingPayload[];
    allRated?: boolean;
}

interface SessionRatingPayload {
    discordId: string;
    username: string;
    rating: number;
}

interface WsAllRatingsPayload {
    ratings: SessionRatingPayload[];
}

interface WsNextEpisodePayload {
    movieName?: string;
    selectedEpisode?: SelectedEpisode;
}

interface WsMessage {
    type: string;
}

const monitorState = {
    socket: null as WebSocket | null,
    roomId: null as string | null,
    checkInterval: null as NodeJS.Timeout | null,
    reconnectTimeout: null as NodeJS.Timeout | null,
    reconnectAttempts: 0,
    lastStatus: "waiting" as "waiting" | "playing" | "ended",
    lastViewerIds: new Set<string>(),
    finalizing: false,
    isEpisodeTransition: false,
    episodeTransitionMovieName: null as string | null,
    episodeTransitionEpisode: null as SelectedEpisode | null,
};

export const startSessionMonitor = (client: Client) => {
    if (monitorState.checkInterval) clearInterval(monitorState.checkInterval);

    monitorState.checkInterval = setInterval(() => {
        const session = activeWatchSession;

        if (!session) {
            resetMonitorState();
            closeSocket();
            return;
        }

        if (Date.now() - session.createdAt > MAX_SESSION_DURATION) {
            logger.warn("SessionMonitor", `Sessão expirada por tempo limite (${session.roomId}). Parando monitoramento.`);
            setActiveWatchSession(null);
            resetMonitorState();
            closeSocket();
            return;
        }

        const socketClosed = !monitorState.socket || monitorState.socket.readyState === WebSocket.CLOSED;
        if (socketClosed || monitorState.roomId !== session.roomId) {
            logger.info("SessionMonitor", `Conectando ao WS: room=${session.roomId}`);
            connectToSession(client, session);
        }
    }, SESSION_CHECK_INTERVAL);
};

function resetMonitorState() {
    monitorState.lastStatus = "waiting";
    monitorState.lastViewerIds = new Set();
    monitorState.roomId = null;
    monitorState.reconnectAttempts = 0;
    monitorState.finalizing = false;
    monitorState.isEpisodeTransition = false;
    monitorState.episodeTransitionMovieName = null;
    monitorState.episodeTransitionEpisode = null;
}

function closeSocket() {
    if (monitorState.reconnectTimeout) {
        clearTimeout(monitorState.reconnectTimeout);
        monitorState.reconnectTimeout = null;
    }

    if (monitorState.socket) {
        monitorState.socket.onclose = null;
        monitorState.socket.onerror = null;
        monitorState.socket.onmessage = null;
        monitorState.socket.onopen = null;
        monitorState.socket.close();
        monitorState.socket = null;
    }
}

function connectToSession(client: Client, session: ActiveWatchSession) {
    closeSocket();
    monitorState.roomId = session.roomId;
    monitorState.finalizing = false;
    monitorState.isEpisodeTransition = false;
    monitorState.episodeTransitionMovieName = null;
    monitorState.episodeTransitionEpisode = null;

    const wsUrl = buildWsUrl(session.roomId);
    monitorState.socket = new WebSocket(wsUrl, {
        headers: {
            "x-room-token": session.hostToken,
        },
    });

    monitorState.socket.onopen = () => {
        logger.info("SessionMonitor", `WS aberto: room=${session.roomId}`);
        monitorState.reconnectAttempts = 0;
        try {
            monitorState.socket?.send(JSON.stringify({ type: "session-status" }));
        } catch {
            monitorState.socket?.close();
        }
    };

    monitorState.socket.onmessage = async (event) => {
        const currentSession = activeWatchSession;
        if (!currentSession || currentSession.roomId !== session.roomId) return;

        let data: WsMessage | null = null;
        try {
            const rawData = typeof event.data === "string" ? event.data : event.data.toString();
            data = JSON.parse(rawData) as WsMessage;
        } catch {
            return;
        }

        if (!data?.type) return;

        switch (data.type) {
            case "viewers":
                await handleViewersUpdate(client, currentSession, data as unknown as WsViewersPayload);
                break;
            case "session-status":
                await handleSessionStatus(client, currentSession, data as unknown as WsSessionStatusPayload);
                break;
            case "session-ending":
            case "session-ended":
                requestSessionStatus();
                break;
            case "all-ratings-received":
                if (monitorState.isEpisodeTransition) {
                    await handleEpisodeRatingsReceived(client, currentSession, data as unknown as WsAllRatingsPayload);
                } else {
                    await handleAllRatingsReceived(client, currentSession, data as unknown as WsAllRatingsPayload);
                }
                break;
            case "episode-ending":
                monitorState.isEpisodeTransition = true;
                monitorState.episodeTransitionMovieName = currentSession.movieName;
                monitorState.episodeTransitionEpisode = currentSession.selectedEpisode ?? null;
                break;
            case "next-episode":
                monitorState.isEpisodeTransition = false;
                monitorState.episodeTransitionMovieName = null;
                monitorState.episodeTransitionEpisode = null;
                await handleNextEpisode(client, currentSession, data as unknown as WsNextEpisodePayload);
                break;
            case "episode-ratings-received":
                break;
        }
    };

    monitorState.socket.onclose = () => {
        logger.info("SessionMonitor", `WS fechado: room=${session.roomId}`);
        monitorState.socket = null;
        scheduleReconnect(client);
    };

    monitorState.socket.onerror = () => {
        logger.warn("SessionMonitor", `WS erro: room=${session.roomId}`);
        monitorState.socket?.close();
    };
}

function buildWsUrl(roomId: string): string {
    const baseUrl = playerApi.getPlayerUrl();
    const wsBase = baseUrl.startsWith("https://")
        ? baseUrl.replace("https://", "wss://")
        : baseUrl.replace("http://", "ws://");
    const clientId = `bot-${Math.random().toString(36).slice(2, 10)}`;
    return `${wsBase}/ws?room=${roomId}&clientId=${clientId}`;
}

function scheduleReconnect(client: Client) {
    if (!activeWatchSession || monitorState.roomId !== activeWatchSession.roomId) return;
    if (monitorState.reconnectTimeout) return;
    if (monitorState.socket && monitorState.socket.readyState === WebSocket.OPEN) return;

    const delay = Math.min(RECONNECT_DELAY * Math.pow(2, monitorState.reconnectAttempts), MAX_RECONNECT_DELAY);
    monitorState.reconnectAttempts++;
    logger.info("SessionMonitor", `Reconectando em ${delay}ms (tentativa ${monitorState.reconnectAttempts})`);

    monitorState.reconnectTimeout = setTimeout(() => {
        monitorState.reconnectTimeout = null;
        if (activeWatchSession) {
            connectToSession(client, activeWatchSession);
        }
    }, delay);
}

function requestSessionStatus() {
    if (!monitorState.socket || monitorState.socket.readyState !== WebSocket.OPEN) return;
    monitorState.socket.send(JSON.stringify({ type: "session-status" }));
}

async function handleViewersUpdate(client: Client, session: ActiveWatchSession, data: WsViewersPayload) {
    const viewers = data.viewers || [];
    const currentIds = new Set(viewers.map(v => v.discordId));

    const hasChanges = currentIds.size !== monitorState.lastViewerIds.size ||
        [...currentIds].some(id => !monitorState.lastViewerIds.has(id));

    if (hasChanges && monitorState.lastStatus === "playing") {
        monitorState.lastViewerIds = currentIds;
        await updateSessionEmbed(client, session, "playing", viewers.length, viewers);
    } else {
        monitorState.lastViewerIds = currentIds;
    }
}

async function handleSessionStatus(client: Client, session: ActiveWatchSession, data: WsSessionStatusPayload) {
    const currentStatus = data.status || "waiting";
    const viewerCount = data.viewerCount ?? data.count ?? 0;
    const viewers = data.viewers || [];
    const ratings = data.ratings || [];
    const currentIds = new Set<string>(viewers.map(v => v.discordId));

    const statusChanged = monitorState.lastStatus !== currentStatus;
    const viewersChanged = currentIds.size !== monitorState.lastViewerIds.size ||
        [...currentIds].some(id => !monitorState.lastViewerIds.has(id));

    monitorState.lastStatus = currentStatus;
    monitorState.lastViewerIds = currentIds;

    if (statusChanged) {
        await updateSessionEmbed(client, session, currentStatus, viewerCount, viewers, ratings);
    } else if (currentStatus === "playing" && viewersChanged) {
        await updateSessionEmbed(client, session, "playing", viewerCount, viewers);
    }

    if (currentStatus === "ended" && data.allRated) {
        await finalizeSession(session, ratings);
    }
}

async function handleAllRatingsReceived(client: Client, session: ActiveWatchSession, data: WsAllRatingsPayload) {
    const ratings = data.ratings || [];

    if (monitorState.lastStatus !== "ended") {
        monitorState.lastStatus = "ended";
    }

    await updateSessionEmbed(client, session, "ended", monitorState.lastViewerIds.size, [], ratings);
    await finalizeSession(session, ratings);
}

async function handleNextEpisode(client: Client, session: ActiveWatchSession, data: WsNextEpisodePayload) {
    const newMovieName = data.movieName || session.movieName;
    const selectedEpisode = data.selectedEpisode || undefined;

    session.movieName = newMovieName;
    session.selectedEpisode = selectedEpisode;

    monitorState.lastStatus = "waiting";

    logger.info("SessionMonitor", `Próximo episódio: ${newMovieName}`);
    await updateSessionEmbed(client, session, "waiting", monitorState.lastViewerIds.size, []);
}

async function handleEpisodeRatingsReceived(client: Client, session: ActiveWatchSession, data: WsAllRatingsPayload) {
    const ratings: SessionRatingPayload[] = data.ratings || [];
    const movieName = monitorState.episodeTransitionMovieName || session.movieName;

    logger.info("SessionMonitor", `Avaliações do episódio recebidas: ${movieName} (${ratings.length} votos)`);

    try {
        await db.registerMovieStart(movieName, session.tmdbInfo as unknown as Record<string, unknown>);

        for (const r of ratings) {
            await db.addVote(movieName, r.discordId, r.username, r.rating);
        }

        logger.info("SessionMonitor", `Votos do episódio persistidos: ${movieName}`);
    } catch (dbError) {
        logger.error("SessionMonitor", "Falha ao persistir votos do episódio", dbError);
    }

    try {
        const channel = await client.channels.fetch(session.channelId) as TextChannel;
        if (channel) {
            const embed = buildSessionEmbed(
                movieName,
                session.tmdbInfo,
                "ended",
                session.hostUsername,
                monitorState.lastViewerIds.size,
                ratings.map(r => ({ ...r, discordId: r.discordId || '', username: r.username || 'User' })) as SessionRating[],
                monitorState.episodeTransitionEpisode ?? undefined,
                session.createdAt
            );

            await channel.send({ embeds: [embed] });
            logger.info("SessionMonitor", `Embed de avaliação do episódio enviado: ${movieName}`);
        }
    } catch (error) {
        logger.error("SessionMonitor", "Falha ao enviar embed de avaliação do episódio", error);
    }
}

async function finalizeSession(session: ActiveWatchSession, ratings: SessionRatingPayload[]) {
    if (monitorState.finalizing) return;
    monitorState.finalizing = true;

    try {
        logger.info("SessionMonitor", `Finalizando sessão: room=${session.roomId} ratings=${ratings.length}`);
        await db.registerMovieStart(session.movieName, session.tmdbInfo as unknown as Record<string, unknown>);

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
        logger.error("SessionMonitor", "Falha ao persistir dados da sessão", dbError);
    }

    setActiveWatchSession(null);
}

async function updateSessionEmbed(
    client: Client,
    session: ActiveWatchSession,
    status: "playing" | "waiting" | "ended",
    viewerCount: number = 0,
    viewers: { discordId: string; username: string }[] = [],
    ratings: SessionRatingPayload[] = []
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
            ratings.map(r => ({ ...r, discordId: r.discordId || '', username: r.username || 'User' })) as SessionRating[],
            session.selectedEpisode,
            session.createdAt
        );

        const playerBaseUrl = playerApi.getPlayerUrl();
        const components = status === "ended" ? [] : buildSessionComponents(session.roomId, status, playerBaseUrl);

        await message.edit({
            embeds: [embed],
            components
        });

    } catch (error) {
        logger.error("SessionMonitor", "Falha ao atualizar mensagem do Discord", error);
    }
}
