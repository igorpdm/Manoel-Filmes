import { Router } from "express";
import { existsSync } from "fs";
import { resolve } from "path";
import { roomManager } from "../../core/room-manager";
import { cleanupRoomUploads } from "./upload";
import { buildSessionStatusData } from "../services/session-status";
import { sendRouteError } from "../http/route-error";
import {
    ConflictHttpError,
    ForbiddenHttpError,
    NotFoundHttpError,
    ValidationHttpError,
} from "../http/http-error";
import { optionalString, requireNonEmptyString, requireObject } from "../http/validation";
import { rateLimit } from "../http/rate-limit";
import { UPLOADS_DIR } from "../../config";
import { logger } from "../../shared/logger";
import type { MovieInfo, SelectedEpisode } from "../../shared/types";

interface CreateRoomPayload {
    videoPath?: string;
    title: string;
    movieName: string;
    movieInfo?: MovieInfo;
    selectedEpisode?: SelectedEpisode;
}

function parseSelectedEpisode(value: unknown): SelectedEpisode | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    const parsed = value as Record<string, unknown>;
    const seasonNumber = Number(parsed.seasonNumber);
    const episodeNumber = Number(parsed.episodeNumber);
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";

    if (!Number.isFinite(seasonNumber) || !Number.isFinite(episodeNumber) || !name) {
        return undefined;
    }

    return {
        id: typeof parsed.id === "number" ? parsed.id : undefined,
        seasonNumber,
        episodeNumber,
        name,
        overview: typeof parsed.overview === "string" ? parsed.overview : undefined,
        stillPath: typeof parsed.stillPath === "string" || parsed.stillPath === null ? parsed.stillPath : undefined,
        airDate: typeof parsed.airDate === "string" ? parsed.airDate : undefined,
        runtime: typeof parsed.runtime === "number" ? parsed.runtime : undefined,
    };
}

function parseCreateRoomPayload(raw: unknown): CreateRoomPayload {
    const payload = requireObject(raw);
    const parsedVideoPath = optionalString(payload.videoPath);

    return {
        videoPath: parsedVideoPath,
        title: optionalString(payload.title) || "Sessão de Cinema",
        movieName: optionalString(payload.movieName) || "Filme Surpresa",
        movieInfo: payload.movieInfo && typeof payload.movieInfo === "object" ? (payload.movieInfo as MovieInfo) : undefined,
        selectedEpisode: parseSelectedEpisode(payload.selectedEpisode),
    };
}

/**
 * Cria rotas HTTP para gerenciamento do ciclo de vida das salas.
 * @returns Router com endpoints de criação, consulta e encerramento de salas.
 */
export function createRoomRouter(): Router {
    const router = Router();

    router.post("/create-room", rateLimit, async (req, res) => {
        try {
            if (roomManager.hasAnyRooms()) {
                throw new ConflictHttpError("Já existe uma sessão ativa");
            }

            const payload = parseCreateRoomPayload(req.body);

            if (payload.videoPath) {
                const resolvedPath = resolve(payload.videoPath);
                const resolvedUploads = resolve(UPLOADS_DIR);
                if (!resolvedPath.startsWith(resolvedUploads)) {
                    throw new ForbiddenHttpError("Por segurança, apenas arquivos dentro da pasta 'uploads' são permitidos.");
                }

                if (!existsSync(payload.videoPath)) {
                    throw new ValidationHttpError("Caminho do vídeo inválido");
                }
            }

            const roomId = roomManager.createRoom(payload.videoPath);
            const room = roomManager.getRoom(roomId);
            if (room) {
                room.title = payload.title;
                room.movieName = payload.movieName;
                if (payload.movieInfo) room.movieInfo = payload.movieInfo;
                if (payload.selectedEpisode) room.selectedEpisode = payload.selectedEpisode;
            }

            const hostId = roomManager.getHostId(roomId);
            logger.info("API", `Sala criada: room=${roomId} host=${hostId}`);
            res.json({ roomId, hostId, url: `/room/${roomId}` });
        } catch (error) {
            sendRouteError(res, error, "APIServer");
        }
    });

    router.get("/room-info/:roomId", (req, res) => {
        const { roomId } = req.params;
        const room = roomManager.getRoom(roomId);
        if (!room) {
            res.status(404).json({ error: "Sala não encontrada" });
            return;
        }
        const connectedUsers = roomManager.getConnectedUsers(roomId);
        res.json({
            title: room.title || "Sessão",
            movieName: room.movieName || "Filme",
            viewerCount: connectedUsers.length,
            movieInfo: room.movieInfo || null,
            selectedEpisode: room.selectedEpisode || null,
        });
    });

    router.post("/end-session/:roomId", async (req, res) => {
        try {
            const { roomId } = req.params;
            const payload = requireObject(req.body);
            const hostId = requireNonEmptyString(payload.hostId, "hostId");

            const room = roomManager.getRoom(roomId);
            if (!room) throw new NotFoundHttpError("Sala não encontrada");

            if (room.state.hostId !== hostId) {
                logger.warn("API", `Encerramento negado (host inválido): room=${roomId}`);
                throw new ForbiddenHttpError("Apenas o host pode encerrar a sessão");
            }

            logger.info("API", `Encerrando sessão (sem Discord): room=${roomId}`);
            roomManager.broadcastAll(roomId, { type: "session-ended" });
            await cleanupRoomUploads(UPLOADS_DIR, roomId);
            await roomManager.deleteRoom(roomId);
            res.json({ success: true });
        } catch (error) {
            sendRouteError(res, error, "APIServer");
        }
    });

    router.get("/room-status/:roomId", (req, res) => {
        const { roomId } = req.params;
        const room = roomManager.getRoom(roomId);
        if (!room) {
            res.status(404).json({ error: "Sala não encontrada" });
            return;
        }
        res.json({
            hasVideo: room.state.videoPath !== "",
            isUploading: room.state.isUploading,
            uploadProgress: room.state.uploadProgress,
            isAwaitingAudioSelection: room.state.isAwaitingAudioSelection,
            audioTracks: room.state.audioTracks,
            audioSelectionErrorMessage: room.state.audioSelectionErrorMessage || "",
            isProcessing: room.state.isProcessing,
            processingMessage: room.state.processingMessage,
        });
    });

    return router;
}

export function getSessionStatusData(roomId: string) {
    return buildSessionStatusData(roomManager, roomId);
}
