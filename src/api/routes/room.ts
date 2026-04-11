import { Router } from "express";
import { roomManager } from "../../core/room-manager";
import { buildSessionStatusData } from "../services/session-status";
import { sendRouteError } from "../http/route-error";
import { requireRoomAccess } from "../http/room-access";

/**
 * Cria rotas HTTP para leitura de dados de salas autenticadas.
 * @returns Router com endpoints de consulta de salas.
 */
export function createRoomRouter(): Router {
    const router = Router();

    router.get("/room-info/:roomId", (req, res) => {
        try {
            const { roomId } = req.params;
            const { room } = requireRoomAccess(roomManager, roomId, req);
            const connectedUsers = roomManager.getConnectedUsers(roomId);
            res.json({
                movieName: room.movieName || "Filme",
                viewerCount: connectedUsers.length,
                movieInfo: room.movieInfo || null,
                selectedEpisode: room.selectedEpisode || null,
                nextEpisode: roomManager.getNextEpisode(roomId),
                episodeHistory: roomManager.getEpisodeHistory(roomId),
            });
        } catch (error) {
            sendRouteError(res, error, "APIServer");
        }
    });

    router.get("/room-status/:roomId", (req, res) => {
        try {
            const { roomId } = req.params;
            const { room } = requireRoomAccess(roomManager, roomId, req);
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
        } catch (error) {
            sendRouteError(res, error, "APIServer");
        }
    });

    return router;
}

export function getSessionStatusData(roomId: string) {
    return buildSessionStatusData(roomManager, roomId);
}
