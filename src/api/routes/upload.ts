import { existsSync, mkdirSync } from "fs";
import { rm } from "fs/promises";
import { promises as fs } from "fs";
import { join, resolve } from "path";
import { Router } from "../http/context";
import { logger } from "../../shared/logger";
import { isPathInsideDirectory } from "../../shared/path-containment";
import type { UploadDeps, UploadMeta } from "./upload-types";
import { getAuthFromRequest, ensureUploadAuthorized } from "./upload-auth";
import {
    getPartPath,
    sanitizeUploadFilename,
} from "./upload-paths";
import { getUploadHandle, closeUploadHandle, activeWriteCounts } from "./upload-handle-cache";
import {
    getOrLoadMeta,
    syncMetaToDisk,
    clearMetaCache,
    initMetaCache,
    getMetaFromCache,
    getReceivedChunkSet,
    markChunkReceived,
    markActivity,
    persistMeta,
} from "./upload-meta-store";
import { computeUploadProgress, maybeBroadcastUploadProgress } from "./upload-progress";
import { startRoomProcessing, getRoomProcessingResponse } from "./upload-media";
import { removeUpload, cleanupRoomUploads as _cleanupRoomUploads, isPathInsideUploadsDir } from "./upload-cleanup";
import { registerSubtitleRoutes, removeRoomSubtitles } from "./upload-subtitles";

export { startUploadCleanup } from "./upload-cleanup";

export async function cleanupRoomUploads(uploadsDir: string, roomId: string): Promise<void> {
    return _cleanupRoomUploads(uploadsDir, roomId, activeUploadsByRoom);
}

const UPLOAD_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_UPLOAD_SIZE_BYTES = 50 * 1024 * 1024 * 1024;
const MAX_UPLOAD_CHUNK_SIZE_BYTES = 16 * 1024 * 1024;
const MAX_UPLOAD_CHUNKS = 100000;

const activeUploadsByRoom = new Map<string, string>();

function resolveUploadDir(uploadsDir: string, uploadId: string): string | null {
    if (!UPLOAD_ID_PATTERN.test(uploadId)) {
        return null;
    }
    const chunksDir = resolve(uploadsDir, uploadId);
    return isPathInsideUploadsDir(uploadsDir, chunksDir) ? chunksDir : null;
}

function parseUploadInteger(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Cria rotas HTTP para upload em chunks, retomada e legendas.
 * @param deps Dependências para autorização e gestão de estado da sala.
 * @returns Instância de router com endpoints de upload.
 */
export function createUploadRouter(deps: UploadDeps): Router {
    const router = Router();

    router.get("/status/:roomId/:uploadId", async (req, res) => {
        const { roomId, uploadId } = req.params;

        const room = deps.roomManager.getRoom(roomId);
        if (!room) {
            res.status(404).json({ error: "Sala não encontrada" });
            return;
        }

        const auth = getAuthFromRequest(req);
        const authError = ensureUploadAuthorized(roomId, auth.token, deps);
        if (authError) { res.status(authError.status).json({ error: authError.error }); return; }

        const chunksDir = resolveUploadDir(deps.uploadsDir, uploadId);
        if (!chunksDir) {
            res.status(400).json({ error: "Upload inválido" });
            return;
        }

        if (!existsSync(chunksDir)) {
            res.status(404).json({ error: "Upload não encontrado" });
            return;
        }

        const meta = await getOrLoadMeta(chunksDir, uploadId);
        if (!meta || meta.roomId !== roomId) {
            res.status(400).json({ error: "Upload inválido" });
            return;
        }

        const receivedSet = getReceivedChunkSet(uploadId) || new Set(meta.receivedChunks || []);
        const existingChunks = Array.from(receivedSet).sort((a, b) => a - b);
        const progress = meta.totalChunks > 0
            ? Math.round((existingChunks.length / meta.totalChunks) * 100)
            : 0;

        deps.roomManager.updateState(roomId, { isUploading: true, uploadProgress: progress });
        deps.roomManager.broadcastAll(roomId, { type: "upload-progress", progress });

        res.json({
            uploadId,
            filename: meta.filename,
            totalChunks: meta.totalChunks,
            existingChunks,
            lastActivity: meta.lastActivity
        });
    });

    router.post("/abort/:roomId/:uploadId", async (req, res) => {
        const { roomId, uploadId } = req.params;

        const room = deps.roomManager.getRoom(roomId);
        if (!room) {
            res.status(404).json({ error: "Sala não encontrada" });
            return;
        }

        const auth = getAuthFromRequest(req);
        const authError = ensureUploadAuthorized(roomId, auth.token, deps);
        if (authError) { res.status(authError.status).json({ error: authError.error }); return; }

        const chunksDir = resolveUploadDir(deps.uploadsDir, uploadId);
        if (!chunksDir) {
            res.status(400).json({ error: "Upload inválido" });
            return;
        }

        await closeUploadHandle(uploadId);
        clearMetaCache(uploadId);
        await removeUpload(deps.uploadsDir, chunksDir);

        if (activeUploadsByRoom.get(roomId) === uploadId) {
            activeUploadsByRoom.delete(roomId);
        }

        deps.roomManager.updateState(roomId, { isUploading: false, uploadProgress: 0 });
        deps.roomManager.broadcastAll(roomId, { type: "pending-upload-cancelled" });

        res.json({ success: true });
    });

    router.post("/init/:roomId", async (req, res) => {
        const { roomId } = req.params;
        const room = deps.roomManager.getRoom(roomId);
        if (!room) {
            res.status(404).json({ error: "Sala não encontrada" });
            return;
        }

        const body = req.body;
        const auth = getAuthFromRequest(req, body);
        const authError = ensureUploadAuthorized(roomId, auth.token, deps);
        if (authError) { res.status(authError.status).json({ error: authError.error }); return; }

        if (room.state.isProcessing || room.state.isAwaitingAudioSelection) {
            res.status(409).json({ error: "Aguarde a seleção e o processamento do áudio antes de enviar outro vídeo" });
            return;
        }

        const filename = typeof body.filename === "string" ? body.filename : "";
        const totalChunks = parseUploadInteger(body.totalChunks) ?? 0;
        const chunkSize = parseUploadInteger(body.chunkSize) ?? 0;
        const totalSize = parseUploadInteger(body.totalSize) ?? 0;

        if (!filename.trim()) {
            res.status(400).json({ error: "Nome do arquivo inválido" });
            return;
        }

        if (
            totalChunks <= 0 ||
            totalChunks > MAX_UPLOAD_CHUNKS ||
            chunkSize <= 0 ||
            chunkSize > MAX_UPLOAD_CHUNK_SIZE_BYTES ||
            totalSize <= 0 ||
            totalSize > MAX_UPLOAD_SIZE_BYTES
        ) {
            res.status(400).json({ error: "Dados de upload inválidos" });
            return;
        }

        const minimumExpectedSize = (totalChunks - 1) * chunkSize;
        const maximumExpectedSize = totalChunks * chunkSize;
        if (totalSize <= minimumExpectedSize || totalSize > maximumExpectedSize) {
            res.status(400).json({ error: "Tamanho total do upload inválido" });
            return;
        }

        const currentUpload = activeUploadsByRoom.get(roomId);
        if (currentUpload) {
            const currentDir = join(deps.uploadsDir, currentUpload);
            await closeUploadHandle(currentUpload);
            await removeUpload(deps.uploadsDir, currentDir);
            clearMetaCache(currentUpload);
            activeUploadsByRoom.delete(roomId);
        }

        const uploadId = `${roomId}_${Date.now()}`;
        const safeFilename = sanitizeUploadFilename(filename);
        const chunksDir = resolveUploadDir(deps.uploadsDir, uploadId);
        if (!chunksDir) {
            res.status(500).json({ error: "Falha ao preparar upload" });
            return;
        }

        mkdirSync(chunksDir, { recursive: true });

        const meta: UploadMeta = {
            roomId,
            uploadId,
            filename: safeFilename,
            totalChunks,
            chunkSize,
            totalSize,
            receivedChunks: [],
            createdAt: Date.now(),
            lastActivity: Date.now()
        };

        initMetaCache(uploadId, meta, chunksDir);
        await persistMeta(chunksDir, meta);
        activeUploadsByRoom.set(roomId, uploadId);

        const partPath = getPartPath(chunksDir);
        const fileHandle = await fs.open(partPath, "w+");
        try {
            if (totalSize > 0) {
                await fileHandle.truncate(totalSize);
            }
        } finally {
            await fileHandle.close();
        }

        deps.roomManager.updateState(roomId, {
            isUploading: true,
            uploadProgress: 0,
            isAwaitingAudioSelection: false,
            audioTracks: [],
            selectedAudioStreamIndex: null,
            audioSelectionErrorMessage: "",
            pendingVideoPath: "",
            processingMessage: "",
        });
        deps.roomManager.broadcastAll(roomId, { type: "upload-start", filename });

        res.json({ uploadId, safeFilename });
    });

    router.post("/chunk/:roomId/:uploadId/:chunkIndex", async (req, res) => {
        const { roomId, uploadId } = req.params;
        const chunkIndex = parseInt(req.params.chunkIndex, 10);

        const room = deps.roomManager.getRoom(roomId);
        if (!room) {
            res.status(404).json({ error: "Sala não encontrada" });
            return;
        }

        const auth = getAuthFromRequest(req);
        const authError = ensureUploadAuthorized(roomId, auth.token, deps);
        if (authError) { res.status(authError.status).json({ error: authError.error }); return; }

        const chunksDir = resolveUploadDir(deps.uploadsDir, uploadId);
        if (!chunksDir) {
            res.status(400).json({ error: "Upload inválido" });
            return;
        }

        if (!existsSync(chunksDir)) {
            res.status(404).json({ error: "Upload não encontrado" });
            return;
        }

        const meta = getMetaFromCache(uploadId) || await getOrLoadMeta(chunksDir, uploadId);
        if (!meta || meta.roomId !== roomId) {
            res.status(400).json({ error: "Upload inválido" });
            return;
        }

        if (chunkIndex < 0 || chunkIndex >= meta.totalChunks) {
            res.status(400).json({ error: "Chunk inválido" });
            return;
        }

        const partPath = getPartPath(chunksDir);
        const chunkSize = meta.chunkSize;
        const position = chunkIndex * chunkSize;
        const expectedChunkSize = Math.min(chunkSize, meta.totalSize - position);

        if (expectedChunkSize <= 0) {
            res.status(400).json({ error: "Chunk inválido" });
            return;
        }

        const fileHandle = await getUploadHandle(uploadId, partPath);
        activeWriteCounts.set(uploadId, (activeWriteCounts.get(uploadId) || 0) + 1);
        let bytesWritten = 0;
        let isChunkTooLarge = false;

        try {
            for await (const chunk of req) {
                if (bytesWritten + chunk.length > expectedChunkSize) {
                    isChunkTooLarge = true;
                    break;
                }
                await fileHandle.write(chunk, 0, chunk.length, position + bytesWritten);
                bytesWritten += chunk.length;
            }
        } catch (e) {
            const isAbort = (e as NodeJS.ErrnoException)?.message === 'aborted' || (e as NodeJS.ErrnoException)?.code === 'ECONNRESET';
            if (!isAbort) {
                logger.error("UploadRoute", `Falha ao escrever chunk ${chunkIndex} do upload ${uploadId}`, e);
            }
            const remaining = (activeWriteCounts.get(uploadId) || 1) - 1;
            if (remaining <= 0) {
                activeWriteCounts.delete(uploadId);
            } else {
                activeWriteCounts.set(uploadId, remaining);
            }
            if (!res.headersSent) {
                res.status(500).json({ error: "Erro ao escrever dados" });
            }
            return;
        }

        const remaining = (activeWriteCounts.get(uploadId) || 1) - 1;
        if (remaining <= 0) {
            activeWriteCounts.delete(uploadId);
        } else {
            activeWriteCounts.set(uploadId, remaining);
        }

        if (isChunkTooLarge) {
            res.status(413).json({ error: "Chunk excede o tamanho permitido" });
            return;
        }

        if (bytesWritten !== expectedChunkSize) {
            res.status(400).json({ error: "Chunk incompleto" });
            return;
        }

        meta.lastActivity = Date.now();
        markChunkReceived(uploadId, chunkIndex);
        meta.receivedChunks = Array.from(getReceivedChunkSet(uploadId) || new Set());
        activeUploadsByRoom.set(roomId, uploadId);
        await persistMeta(chunksDir, meta);

        const progress = computeUploadProgress(meta, getReceivedChunkSet(uploadId));
        deps.roomManager.updateState(roomId, { isUploading: true, uploadProgress: progress });
        maybeBroadcastUploadProgress(roomId, deps, progress);

        res.json({ success: true, chunkIndex, progress });
    });

    router.post("/complete/:roomId/:uploadId", async (req, res) => {
        const { roomId, uploadId } = req.params;

        const room = deps.roomManager.getRoom(roomId);
        if (!room) {
            res.status(404).json({ error: "Sala não encontrada" });
            return;
        }

        const body = req.body;
        const auth = getAuthFromRequest(req, body);
        const authError = ensureUploadAuthorized(roomId, auth.token, deps);
        if (authError) { res.status(authError.status).json({ error: authError.error }); return; }

        const chunksDir = resolveUploadDir(deps.uploadsDir, uploadId);
        if (!chunksDir) {
            res.status(400).json({ error: "Upload inválido" });
            return;
        }

        const meta = getMetaFromCache(uploadId) || await getOrLoadMeta(chunksDir, uploadId);
        if (!meta || meta.roomId !== roomId) {
            res.status(400).json({ error: "Upload inválido" });
            return;
        }

        const receivedSet = getReceivedChunkSet(uploadId);
        if (!receivedSet || receivedSet.size !== meta.totalChunks) {
            res.status(400).json({ error: "Upload incompleto", received: receivedSet?.size || 0, expected: meta.totalChunks });
            return;
        }

        const safeFilename = meta.filename;
        const finalPath = join(deps.uploadsDir, `${uploadId}_${safeFilename}`);
        const partPath = getPartPath(chunksDir);

        await closeUploadHandle(uploadId);
        await syncMetaToDisk(uploadId);
        clearMetaCache(uploadId);

        await fs.rename(partPath, finalPath);
        await removeUpload(deps.uploadsDir, chunksDir);

        if (activeUploadsByRoom.get(roomId) === uploadId) {
            activeUploadsByRoom.delete(roomId);
        }

        const { MediaProcessor } = await import("../services/media-processor");
        const processor = new MediaProcessor(deps.roomManager);
        const audioTracks = await processor.listAudioTracks(finalPath);

        if (audioTracks.length > 1) {
            deps.roomManager.updateState(roomId, {
                isUploading: false,
                uploadProgress: 100,
                isAwaitingAudioSelection: true,
                audioTracks,
                selectedAudioStreamIndex: null,
                audioSelectionErrorMessage: "",
                pendingVideoPath: finalPath,
                isProcessing: false,
                processingMessage: "",
            });

            deps.roomManager.broadcastAll(roomId, {
                type: "audio-track-selection-required",
                audioTracks,
                errorMessage: "",
            });

            res.json({
                success: true,
                filename: safeFilename,
                requiresAudioSelection: true,
                audioTracks,
            });
            return;
        }

        const selectedAudioStreamIndex = audioTracks.length === 1 ? audioTracks[0].streamIndex : undefined;
        const processingState = await startRoomProcessing(roomId, finalPath, deps, selectedAudioStreamIndex, audioTracks);

        if (processingState.requiresAudioSelection) {
            res.json({
                success: true,
                filename: safeFilename,
                requiresAudioSelection: true,
                audioTracks: processingState.audioTracks,
                errorMessage: processingState.errorMessage,
            });
            return;
        }

        res.json({
            success: true,
            filename: safeFilename,
            processing: processingState.processing,
            ready: processingState.ready,
        });
    });

    router.post("/audio-track/:roomId", async (req, res) => {
        const { roomId } = req.params;
        const room = deps.roomManager.getRoom(roomId);
        if (!room) {
            res.status(404).json({ error: "Sala não encontrada" });
            return;
        }

        const auth = getAuthFromRequest(req, req.body);
        const authError = ensureUploadAuthorized(roomId, auth.token, deps);
        if (authError) { res.status(authError.status).json({ error: authError.error }); return; }

        if (room.state.isProcessing) {
            res.status(409).json({ error: "A sala já está em processamento" });
            return;
        }

        if (!room.state.isAwaitingAudioSelection) {
            res.status(409).json({ error: "Não há seleção de faixa de áudio pendente" });
            return;
        }

        const streamIndex = Number(req.body?.streamIndex);
        if (!Number.isInteger(streamIndex)) {
            res.status(400).json({ error: "Faixa de áudio inválida" });
            return;
        }

        const selectedTrack = room.state.audioTracks.find((track) => track.streamIndex === streamIndex);
        if (!selectedTrack) {
            res.status(400).json({ error: "Faixa de áudio não encontrada" });
            return;
        }

        if (!room.state.pendingVideoPath) {
            res.status(400).json({ error: "Arquivo pendente não encontrado" });
            return;
        }

        const processingState = await startRoomProcessing(roomId, room.state.pendingVideoPath, deps, streamIndex, room.state.audioTracks);

        if (processingState.requiresAudioSelection) {
            res.json({
                success: true,
                requiresAudioSelection: true,
                audioTracks: processingState.audioTracks,
                errorMessage: processingState.errorMessage,
            });
            return;
        }

        res.json({
            success: true,
            processing: processingState.processing,
            ready: processingState.ready,
        });
    });

    router.post("/cancel-pending/:roomId", async (req, res) => {
        const { roomId } = req.params;
        const room = deps.roomManager.getRoom(roomId);
        if (!room) {
            res.status(404).json({ error: "Sala não encontrada" });
            return;
        }

        const auth = getAuthFromRequest(req, req.body);
        const authError = ensureUploadAuthorized(roomId, auth.token, deps);
        if (authError) {
            res.status(authError.status).json({ error: authError.error });
            return;
        }

        if (room.state.isProcessing) {
            res.status(409).json({ error: "Não é possível cancelar enquanto o arquivo está em processamento" });
            return;
        }

        if (!room.state.pendingVideoPath) {
            res.status(400).json({ error: "Nenhum arquivo pendente para cancelar" });
            return;
        }

        const pendingPath = room.state.pendingVideoPath;
        if (!isPathInsideDirectory(deps.uploadsDir, pendingPath)) {
            res.status(403).json({ error: "Arquivo pendente inválido" });
            return;
        }

        if (existsSync(pendingPath)) {
            try {
                await rm(pendingPath, { force: true });
            } catch (error) {
                logger.error("UploadRoute", `Falha ao remover arquivo pendente ${pendingPath}`, error);
            }
        }

        await removeRoomSubtitles(deps, roomId);

        deps.roomManager.updateState(roomId, {
            isUploading: false,
            uploadProgress: 0,
            pendingVideoPath: "",
            isAwaitingAudioSelection: false,
            audioTracks: [],
            selectedAudioStreamIndex: null,
            audioSelectionErrorMessage: "",
            isProcessing: false,
            processingMessage: "",
        });

        deps.roomManager.broadcastAll(roomId, { type: "pending-upload-cancelled" });

        res.json({ success: true });
    });

    router.post("/progress/:roomId", async (req, res) => {
        const { roomId } = req.params;

        const room = deps.roomManager.getRoom(roomId);
        if (!room) {
            res.status(404).json({ error: "Sala não encontrada" });
            return;
        }

        const body = req.body;
        const auth = getAuthFromRequest(req, body);
        const authError = ensureUploadAuthorized(roomId, auth.token, deps);
        if (authError) { res.status(authError.status).json({ error: authError.error }); return; }

        const bodyUploadId = typeof body.uploadId === "string" ? body.uploadId : "";
        const effectiveUploadId = bodyUploadId || activeUploadsByRoom.get(roomId);

        if (effectiveUploadId) {
            const chunksDir = resolveUploadDir(deps.uploadsDir, effectiveUploadId);
            if (!chunksDir) {
                res.status(400).json({ error: "Upload inválido" });
                return;
            }

            if (existsSync(chunksDir)) {
                activeUploadsByRoom.set(roomId, effectiveUploadId);
                markActivity(effectiveUploadId).catch((error) => {
                    logger.error("UploadRoute", `Falha ao marcar atividade do upload ${effectiveUploadId}`, error);
                });

                const meta = getMetaFromCache(effectiveUploadId) || await getOrLoadMeta(chunksDir, effectiveUploadId);
                if (meta && meta.roomId === roomId) {
                    const receivedSet = getReceivedChunkSet(effectiveUploadId) || new Set(meta.receivedChunks || []);

                    const progress = computeUploadProgress(meta, receivedSet);
                    deps.roomManager.updateState(roomId, { isUploading: true, uploadProgress: progress });
                    maybeBroadcastUploadProgress(roomId, deps, progress);
                    res.json({ success: true, progress });
                    return;
                }
            }
        }

        res.json({ success: true });
    });

    registerSubtitleRoutes(router, deps);

    return router;
}
