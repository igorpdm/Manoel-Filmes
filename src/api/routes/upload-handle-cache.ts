import { promises as fs } from "fs";
import { logger } from "../../shared/logger";

interface HandleEntry {
    handle: fs.FileHandle;
    lastUsed: number;
}

const HANDLE_TTL_MS = 60000;

const fileHandleCache = new Map<string, HandleEntry>();
const fileHandleOpenPromises = new Map<string, Promise<fs.FileHandle>>();
export const activeWriteCounts = new Map<string, number>();

setInterval(async () => {
    const now = Date.now();
    for (const [uploadId, cached] of fileHandleCache.entries()) {
        const activeWrites = activeWriteCounts.get(uploadId) || 0;
        if (activeWrites === 0 && now - cached.lastUsed > HANDLE_TTL_MS) {
            await closeUploadHandle(uploadId);
        }
    }
}, 15000);

export async function getUploadHandle(uploadId: string, partPath: string): Promise<fs.FileHandle> {
    const cached = fileHandleCache.get(uploadId);
    if (cached) {
        cached.lastUsed = Date.now();
        return cached.handle;
    }

    const pending = fileHandleOpenPromises.get(uploadId);
    if (pending) {
        return pending;
    }

    const openPromise = fs.open(partPath, "r+")
        .then((handle) => {
            fileHandleCache.set(uploadId, { handle, lastUsed: Date.now() });
            return handle;
        })
        .finally(() => {
            fileHandleOpenPromises.delete(uploadId);
        });

    fileHandleOpenPromises.set(uploadId, openPromise);
    return openPromise;
}

export async function closeUploadHandle(uploadId: string) {
    if ((activeWriteCounts.get(uploadId) || 0) > 0) return;

    const pending = fileHandleOpenPromises.get(uploadId);
    if (pending) {
        try {
            const handle = await pending;
            await handle.close();
        } catch (e) {
            logger.error("UploadHandleCache", `Falha ao fechar handle pendente do upload ${uploadId}`, e);
        }
        fileHandleCache.delete(uploadId);
        fileHandleOpenPromises.delete(uploadId);
        return;
    }

    const cached = fileHandleCache.get(uploadId);
    if (cached) {
        try {
            await cached.handle.close();
        } catch (e) {
            logger.error("UploadHandleCache", `Falha ao fechar handle do upload ${uploadId}`, e);
        }
        fileHandleCache.delete(uploadId);
    }
}
