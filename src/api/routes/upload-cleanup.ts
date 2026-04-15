import { existsSync, readdirSync, statSync } from "fs";
import { rm } from "fs/promises";
import { join, basename, resolve, sep } from "path";
import { logger } from "../../shared/logger";
import { getSubtitlesDir, listRoomUploadDirs } from "./upload-paths";
import { closeUploadHandle } from "./upload-handle-cache";
import { clearMetaCache, getMetaFromCache, getReceivedChunkSet, readMeta, initMetaCache } from "./upload-meta-store";
import type { UploadMeta } from "./upload-types";

const UPLOAD_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL = 5 * 60 * 1000;

export function isPathInsideUploadsDir(uploadsDir: string, targetPath: string): boolean {
    const uploadsRoot = resolve(uploadsDir);
    const resolvedTargetPath = resolve(targetPath);
    return resolvedTargetPath === uploadsRoot || resolvedTargetPath.startsWith(uploadsRoot + sep);
}

export async function removeUpload(uploadsDir: string, chunksDir: string): Promise<void> {
    if (!isPathInsideUploadsDir(uploadsDir, chunksDir)) {
        logger.warn("UploadCleanup", `Ignorando remoção fora da pasta de uploads: ${chunksDir}`);
        return;
    }

    if (existsSync(chunksDir)) {
        try {
            await rm(chunksDir, { recursive: true, force: true });
        } catch (e) {
            logger.error("UploadCleanup", `Falha ao remover pasta de upload ${chunksDir}`, e);
        }
    }
}

async function cleanupUploads(uploadsDir: string): Promise<void> {
    if (!existsSync(uploadsDir)) return;
    const entries = readdirSync(uploadsDir, { withFileTypes: true });
    const now = Date.now();

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.endsWith("_subtitles")) continue;

        const uploadId = entry.name;
        const dirPath = join(uploadsDir, uploadId);

        let meta: UploadMeta | null = getMetaFromCache(uploadId) ?? null;

        if (!meta) {
            meta = readMeta(dirPath);
            if (meta) {
                initMetaCache(uploadId, meta, dirPath);
            }
        }

        const age = meta?.lastActivity
            ? now - meta.lastActivity
            : now - statSync(dirPath).mtimeMs;

        if (age > UPLOAD_TTL_MS) {
            await closeUploadHandle(uploadId);
            clearMetaCache(uploadId);
            await removeUpload(uploadsDir, dirPath);
        }
    }
}

/**
 * Remove todos os arquivos e subpastas da pasta de uploads.
 * Chamado na inicialização do servidor para garantir armazenamento limpo.
 * @param uploadsDir Diretório base de uploads.
 */
export async function clearAllUploads(uploadsDir: string): Promise<void> {
    if (!existsSync(uploadsDir)) return;

    const entries = readdirSync(uploadsDir, { withFileTypes: true });
    if (entries.length === 0) return;

    await Promise.all(
        entries.map(entry =>
            rm(join(uploadsDir, entry.name), { recursive: true, force: true })
        )
    );

    logger.info("UploadCleanup", `Pasta de uploads limpa na inicialização (${entries.length} item(ns) removido(s))`);
}

/**
 * Inicia limpeza periódica de uploads temporários expirados.
 * @param uploadsDir Diretório base de uploads.
 */
export function startUploadCleanup(uploadsDir: string): void {
    setInterval(() => cleanupUploads(uploadsDir), CLEANUP_INTERVAL);
}

/**
 * Remove arquivos temporários de upload e legendas de uma sala.
 * @param uploadsDir Diretório base de uploads.
 * @param roomId Identificador da sala.
 * @param activeUploadsByRoom Mapa de uploads ativos por sala.
 */
export async function cleanupRoomUploads(
    uploadsDir: string,
    roomId: string,
    activeUploadsByRoom: Map<string, string>
): Promise<void> {
    const activeUploadId = activeUploadsByRoom.get(roomId);
    if (activeUploadId) {
        const activeDir = join(uploadsDir, activeUploadId);
        await closeUploadHandle(activeUploadId);
        clearMetaCache(activeUploadId);
        await removeUpload(uploadsDir, activeDir);
        activeUploadsByRoom.delete(roomId);
    }

    const dirs = listRoomUploadDirs(uploadsDir, roomId);
    for (const dir of dirs) {
        const dirName = basename(dir);
        if (dirName) {
            await closeUploadHandle(dirName);
            clearMetaCache(dirName);
        }
        await removeUpload(uploadsDir, dir);
    }

    const subtitlesDir = getSubtitlesDir(uploadsDir, roomId);
    if (existsSync(subtitlesDir)) {
        try {
            await rm(subtitlesDir, { recursive: true, force: true });
        } catch (e) {
            logger.error("UploadCleanup", `Falha ao remover pasta de legendas ${subtitlesDir}`, e);
        }
    }
}
