import { existsSync, readFileSync } from "fs";
import { promises as fs } from "fs";
import { join } from "path";
import type { UploadMeta } from "./upload-types";

const metaCache = new Map<string, UploadMeta>();
const receivedChunkSets = new Map<string, Set<number>>();
const metaLoadPromises = new Map<string, Promise<UploadMeta | null>>();
const uploadDirsById = new Map<string, string>();

function getMetaPath(chunksDir: string): string {
    return join(chunksDir, "meta.json");
}

async function readMetaAsync(chunksDir: string): Promise<UploadMeta | null> {
    const metaPath = getMetaPath(chunksDir);
    try {
        const raw = await fs.readFile(metaPath, "utf8");
        return JSON.parse(raw) as UploadMeta;
    } catch {
        return null;
    }
}

async function writeMetaAsync(chunksDir: string, meta: UploadMeta): Promise<void> {
    const metaPath = getMetaPath(chunksDir);
    await fs.writeFile(metaPath, JSON.stringify(meta));
}

export function readMeta(chunksDir: string): UploadMeta | null {
    const metaPath = getMetaPath(chunksDir);
    if (!existsSync(metaPath)) return null;
    try {
        const raw = readFileSync(metaPath, "utf8");
        return JSON.parse(raw) as UploadMeta;
    } catch {
        return null;
    }
}

export async function getOrLoadMeta(chunksDir: string, uploadId: string): Promise<UploadMeta | null> {
    const pending = metaLoadPromises.get(uploadId);
    if (pending) return pending;

    const cached = metaCache.get(uploadId);
    if (cached) return cached;

    const loadPromise = (async () => {
        const meta = await readMetaAsync(chunksDir);
        if (meta) {
            metaCache.set(uploadId, meta);
            receivedChunkSets.set(uploadId, new Set(meta.receivedChunks || []));
            uploadDirsById.set(uploadId, chunksDir);
        }
        return meta;
    })();
    metaLoadPromises.set(uploadId, loadPromise);
    try {
        return await loadPromise;
    } finally {
        metaLoadPromises.delete(uploadId);
    }
}

export async function syncMetaToDisk(uploadId: string): Promise<void> {
    const meta = metaCache.get(uploadId);
    const chunksDir = uploadDirsById.get(uploadId);
    if (!meta || !chunksDir) return;

    const receivedSet = receivedChunkSets.get(uploadId);
    if (receivedSet) {
        meta.receivedChunks = Array.from(receivedSet);
    }
    await writeMetaAsync(chunksDir, meta);
}

export function clearMetaCache(uploadId: string): void {
    metaCache.delete(uploadId);
    receivedChunkSets.delete(uploadId);
    metaLoadPromises.delete(uploadId);
    uploadDirsById.delete(uploadId);
}

export function initMetaCache(uploadId: string, meta: UploadMeta, chunksDir: string): void {
    metaCache.set(uploadId, meta);
    receivedChunkSets.set(uploadId, new Set());
    uploadDirsById.set(uploadId, chunksDir);
}

export function getMetaFromCache(uploadId: string): UploadMeta | undefined {
    return metaCache.get(uploadId);
}

export function getReceivedChunkSet(uploadId: string): Set<number> | undefined {
    return receivedChunkSets.get(uploadId);
}

export function markChunkReceived(uploadId: string, chunkIndex: number): void {
    const set = receivedChunkSets.get(uploadId) || new Set<number>();
    set.add(chunkIndex);
    receivedChunkSets.set(uploadId, set);
}

export async function markActivity(uploadId: string): Promise<void> {
    const meta = metaCache.get(uploadId);
    if (!meta) return;
    meta.lastActivity = Date.now();
}

export async function persistMeta(chunksDir: string, meta: UploadMeta): Promise<void> {
    await writeMetaAsync(chunksDir, meta);
}
