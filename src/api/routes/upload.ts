import { Router } from "express";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, promises as fs } from "fs";
import { rm } from "fs/promises";
import { join, basename } from "path";
import type { Request, Response } from "express";
import type { RoomManager } from "../../core/room-manager";
import { MediaProcessor } from "../services/media-processor";

interface UploadDeps {
  roomManager: typeof RoomManager.prototype;
  uploadsDir: string;
}

interface UploadMeta {
  roomId: string;
  uploadId: string;
  filename: string;
  totalChunks: number;
  chunkSize: number;
  totalSize: number;
  receivedChunks: number[];
  createdAt: number;
  lastActivity: number;
}

const activeUploadsByRoom = new Map<string, string>();
const UPLOAD_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL = 5 * 60 * 1000;

// Cache for open file handles: uploadId -> { handle, lastUsed }
const fileHandleCache = new Map<string, { handle: fs.FileHandle, lastUsed: number }>();
const HANDLE_TTL_MS = 60000; // Close handle after 60s of inactivity (increased for parallel uploads)
const activeWriteCounts = new Map<string, number>();

// Metadata Cache - simplified for performance (no disk sync during upload)
const metaCache = new Map<string, UploadMeta>();
const receivedChunkSets = new Map<string, Set<number>>();
const metaLoadPromises = new Map<string, Promise<UploadMeta | null>>();
const uploadDirsById = new Map<string, string>();

// Progresso deve ser calculado pelo servidor a partir dos chunks recebidos.
// Throttle para não inundar o WS em uploads rápidos.
const progressBroadcastByRoom = new Map<string, { progress: number; lastSent: number }>();
const PROGRESS_BROADCAST_THROTTLE_MS = 250;

function computeUploadProgress(meta: UploadMeta, receivedSet: Set<number> | undefined): number {
  if (!meta.totalChunks) return 0;
  const received = receivedSet?.size || 0;
  // Evita mostrar 100% antes do /complete finalizar.
  return Math.min(99, Math.round((received / meta.totalChunks) * 100));
}

function maybeBroadcastUploadProgress(roomId: string, deps: UploadDeps, progress: number, force = false) {
  const now = Date.now();
  const prev = progressBroadcastByRoom.get(roomId);

  const previousProgress = prev?.progress;

  // Sempre guarda o último progresso observado.
  if (!prev) {
    progressBroadcastByRoom.set(roomId, { progress, lastSent: 0 });
  } else {
    prev.progress = progress;
  }

  const state = progressBroadcastByRoom.get(roomId)!;

  if (!force) {
    if (now - state.lastSent < PROGRESS_BROADCAST_THROTTLE_MS) return;
    if (previousProgress === progress && state.lastSent > 0) return;
  }

  state.lastSent = now;
  deps.roomManager.broadcastAll(roomId, { type: "upload-progress", progress });
}

async function getUploadHandle(uploadId: string, partPath: string): Promise<fs.FileHandle> {
  const cached = fileHandleCache.get(uploadId);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.handle;
  }

  const handle = await fs.open(partPath, "r+");
  fileHandleCache.set(uploadId, { handle, lastUsed: Date.now() });
  return handle;
}

async function closeUploadHandle(uploadId: string) {
  if ((activeWriteCounts.get(uploadId) || 0) > 0) return;
  const cached = fileHandleCache.get(uploadId);
  if (cached) {
    try {
      await cached.handle.close();
    } catch (e) {
      console.error(`[Upload] Error closing handle for ${uploadId}:`, e);
    }
    fileHandleCache.delete(uploadId);
  }
}

async function getOrLoadMeta(chunksDir: string, uploadId: string): Promise<UploadMeta | null> {
  const pending = metaLoadPromises.get(uploadId);
  if (pending) return pending;
  
  // 1. Try Cache first (fast path)
  const cached = metaCache.get(uploadId);
  if (cached) return cached;

  // 2. Load from disk only if not in cache
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

// Sync metadata to disk - called only on init, complete, abort
async function syncMetaToDisk(uploadId: string): Promise<void> {
  const meta = metaCache.get(uploadId);
  const chunksDir = uploadDirsById.get(uploadId);
  if (!meta || !chunksDir) return;
  
  const receivedSet = receivedChunkSets.get(uploadId);
  if (receivedSet) {
    meta.receivedChunks = Array.from(receivedSet);
  }
  await writeMetaAsync(chunksDir, meta);
}

function clearMetaCache(uploadId: string) {
  metaCache.delete(uploadId);
  receivedChunkSets.delete(uploadId);
  metaLoadPromises.delete(uploadId);
  uploadDirsById.delete(uploadId);
}

// Check for idle handles periodically
setInterval(async () => {
  const now = Date.now();
  for (const [uploadId, cached] of fileHandleCache.entries()) {
    // Only close if no active writes and handle is idle
    const activeWrites = activeWriteCounts.get(uploadId) || 0;
    if (activeWrites === 0 && now - cached.lastUsed > HANDLE_TTL_MS) {
      await closeUploadHandle(uploadId);
    }
  }
}, 15000);


function getMetaPath(chunksDir: string) {
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

async function writeMetaAsync(chunksDir: string, meta: UploadMeta) {
  const metaPath = getMetaPath(chunksDir);
  await fs.writeFile(metaPath, JSON.stringify(meta));
}

function readMeta(chunksDir: string): UploadMeta | null {
  const metaPath = getMetaPath(chunksDir);
  if (!existsSync(metaPath)) return null;
  try {
    const raw = readFileSync(metaPath, "utf8");
    return JSON.parse(raw) as UploadMeta;
  } catch {
    return null;
  }
}

async function markActivity(chunksDir: string, uploadId: string) {
  const meta = metaCache.get(uploadId);
  if (!meta) return;
  meta.lastActivity = Date.now();
}

async function removeUpload(chunksDir: string) {
  if (existsSync(chunksDir)) {
    try {
      await rm(chunksDir, { recursive: true, force: true });
    } catch (e) {
      console.error(`[Upload] Failed to remove upload dir ${chunksDir}:`, e);
    }
  }
}

function listRoomUploadDirs(uploadsDir: string, roomId: string) {
  if (!existsSync(uploadsDir)) return [];
  const entries = readdirSync(uploadsDir, { withFileTypes: true });
  const prefix = `${roomId}_`;
  return entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
    .map(entry => join(uploadsDir, entry.name));
}

function getPartPath(chunksDir: string) {
  return join(chunksDir, "upload.part");
}

async function cleanupUploads(uploadsDir: string) {
  if (!existsSync(uploadsDir)) return;
  const entries = readdirSync(uploadsDir, { withFileTypes: true });
  const now = Date.now();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.endsWith('_subtitles')) continue;
    
    const uploadId = entry.name;
    const dirPath = join(uploadsDir, uploadId);
    
    // Check cache first for most recent activity
    let meta: UploadMeta | null = metaCache.get(uploadId) ?? null;
    
    // If not in cache, try reading from disk
    if (!meta) {
        meta = readMeta(dirPath);
        if (meta) {
          metaCache.set(uploadId, meta);
          receivedChunkSets.set(uploadId, new Set(meta.receivedChunks || []));
          uploadDirsById.set(uploadId, dirPath);
        }
    }

    const age = meta?.lastActivity
      ? now - meta.lastActivity
      : now - statSync(dirPath).mtimeMs;

    if (age > UPLOAD_TTL_MS) {
      // Ensure we clean up cache if we are deleting
      await closeUploadHandle(uploadId);
      clearMetaCache(uploadId);
      await removeUpload(dirPath);
    }
  }
}

function getAuthFromRequest(request: Request, body?: any) {
  const token = (body?.token || request.headers["x-room-token"] || "") as string;
  const hostId = (body?.hostId || request.headers["x-host-id"] || "") as string;
  return { token, hostId };
}

function ensureUploadAuthorized(roomId: string, token: string, hostId: string, deps: UploadDeps): { error: string, status: number } | null {
  const room = deps.roomManager.getRoom(roomId);
  if (!room) {
    return { error: "Sala não encontrada", status: 404 };
  }

  if (room.status === 'ended') {
    return { error: "Sessão encerrada", status: 403 };
  }

  if (room.discordSession) {
    if (!token || !deps.roomManager.isHostByToken(roomId, token)) {
      return { error: "Sem permissão para upload", status: 403 };
    }
  } else {
    if (!hostId || room.state.hostId !== hostId) {
      return { error: "Sem permissão para upload", status: 403 };
    }
  }

  return null;
}

function getSubtitlesDir(uploadsDir: string, roomId: string): string {
  return join(uploadsDir, `${roomId}_subtitles`);
}

function decodeSubtitleBuffer(buffer: Buffer): string {
  // UTF-8 BOM
  if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return buffer.subarray(3).toString("utf-8");
  }

  const utf8 = buffer.toString("utf-8");

  // Se não contém replacement char, é UTF-8 válido
  if (!utf8.includes("\uFFFD")) return utf8;

  // Fallback: Windows-1252 (superset de Latin-1, comum em legendas em português)
  const decoder = new TextDecoder("windows-1252");
  return decoder.decode(buffer);
}

export function startUploadCleanup(uploadsDir: string) {
  setInterval(() => cleanupUploads(uploadsDir), CLEANUP_INTERVAL);
}

export async function cleanupRoomUploads(uploadsDir: string, roomId: string) {
  const activeUploadId = activeUploadsByRoom.get(roomId);
  if (activeUploadId) {
    const activeDir = join(uploadsDir, activeUploadId);
    await closeUploadHandle(activeUploadId);
    clearMetaCache(activeUploadId);
    await removeUpload(activeDir);
    activeUploadsByRoom.delete(roomId);
  }

  const dirs = listRoomUploadDirs(uploadsDir, roomId);
  for (const dir of dirs) {
    // Try to extract uploadId from dir name "roomId_timestamp" - not perfect but we can rely on TTL mostly.
    // However, if we are force cleaning, we should try to close handles if they exist in cache
    // Iterate cache to find matching roomId? Expensive.
    // For now, relies on TTL or explicit activeUploadId.
    // Better: Extract basename and try to close/clear.
    const dirName = basename(dir);
    if (dirName) {
         await closeUploadHandle(dirName);
         clearMetaCache(dirName);
    }
    await removeUpload(dir);
  }

  const subtitlesDir = getSubtitlesDir(uploadsDir, roomId);
  if (existsSync(subtitlesDir)) {
    try {
      await rm(subtitlesDir, { recursive: true, force: true });
    } catch (e) {
      console.error(`[Upload] Failed to remove subtitles dir ${subtitlesDir}:`, e);
    }
  }
}

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
    const authError = ensureUploadAuthorized(roomId, auth.token, auth.hostId, deps);
    if (authError) { res.status(authError.status).json({ error: authError.error }); return; }

    const chunksDir = join(deps.uploadsDir, uploadId);
    if (!existsSync(chunksDir)) {
      res.status(404).json({ error: "Upload não encontrado" });
      return;
    }

    const meta = await getOrLoadMeta(chunksDir, uploadId);
    if (!meta || meta.roomId !== roomId) {
      res.status(400).json({ error: "Upload inválido" });
      return;
    }

    const receivedSet = receivedChunkSets.get(uploadId) || new Set(meta.receivedChunks || []);
    receivedChunkSets.set(uploadId, receivedSet);
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
    const authError = ensureUploadAuthorized(roomId, auth.token, auth.hostId, deps);
    if (authError) { res.status(authError.status).json({ error: authError.error }); return; }

    const chunksDir = join(deps.uploadsDir, uploadId);
    
    await closeUploadHandle(uploadId);
    clearMetaCache(uploadId);
    await removeUpload(chunksDir);

    if (activeUploadsByRoom.get(roomId) === uploadId) {
      activeUploadsByRoom.delete(roomId);
    }

    deps.roomManager.updateState(roomId, { isUploading: false, uploadProgress: 0 });
    deps.roomManager.broadcastAll(roomId, { type: "upload-progress", progress: 0 });

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
    const authError = ensureUploadAuthorized(roomId, auth.token, auth.hostId, deps);
    if (authError) { res.status(authError.status).json({ error: authError.error }); return; }

    const { filename } = body;
    const totalChunks = Number(body.totalChunks) || 0;
    const chunkSize = Number(body.chunkSize) || 0;
    const totalSize = Number(body.totalSize) || 0;

    if (!totalChunks || !chunkSize) {
      res.status(400).json({ error: "Dados de upload inválidos" });
      return;
    }

    const currentUpload = activeUploadsByRoom.get(roomId);
    if (currentUpload) {
      const currentDir = join(deps.uploadsDir, currentUpload);
      await removeUpload(currentDir);
      clearMetaCache(currentUpload);
      activeUploadsByRoom.delete(roomId);
    }

    const uploadId = `${roomId}_${Date.now()}`;
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const chunksDir = join(deps.uploadsDir, uploadId);

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

    // Initialize cache and write to disk
    metaCache.set(uploadId, meta);
    receivedChunkSets.set(uploadId, new Set());
    uploadDirsById.set(uploadId, chunksDir);
    await writeMetaAsync(chunksDir, meta);
    activeUploadsByRoom.set(roomId, uploadId);

    const partPath = getPartPath(chunksDir);
    const fileHandle = await fs.open(partPath, "w+");
    if (totalSize > 0) {
      await fileHandle.truncate(totalSize);
    }
    await fileHandle.close();

    deps.roomManager.updateState(roomId, { isUploading: true, uploadProgress: 0 });
    deps.roomManager.broadcastAll(roomId, { type: "upload-start", filename });

    res.json({ uploadId, safeFilename, chunksDir });
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
    const authError = ensureUploadAuthorized(roomId, auth.token, auth.hostId, deps);
    if (authError) { res.status(authError.status).json({ error: authError.error }); return; }

    const chunksDir = join(deps.uploadsDir, uploadId);
    if (!existsSync(chunksDir)) {
      res.status(404).json({ error: "Upload não encontrado" });
      return;
    }

    const meta = metaCache.get(uploadId) || await getOrLoadMeta(chunksDir, uploadId);
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
    const fileHandle = await getUploadHandle(uploadId, partPath);
    activeWriteCounts.set(uploadId, (activeWriteCounts.get(uploadId) || 0) + 1);

    try {
      let offset = position;
      for await (const chunk of req) {
        await fileHandle.write(chunk, 0, chunk.length, offset);
        offset += chunk.length;
      }
    } catch (e) {
      console.error(`[Upload] Error writing chunk ${chunkIndex} for ${uploadId}:`, e);
      const remaining = (activeWriteCounts.get(uploadId) || 1) - 1;
      if (remaining <= 0) {
        activeWriteCounts.delete(uploadId);
      } else {
        activeWriteCounts.set(uploadId, remaining);
      }
      res.status(500).json({ error: "Erro ao escrever dados" });
      return;
    }

    // Decrement active write count
    const remaining = (activeWriteCounts.get(uploadId) || 1) - 1;
    if (remaining <= 0) {
      activeWriteCounts.delete(uploadId);
    } else {
      activeWriteCounts.set(uploadId, remaining);
    }

    // Update in-memory state only (no disk I/O)
    meta.lastActivity = Date.now();
    const receivedSet = receivedChunkSets.get(uploadId) || new Set<number>();
    receivedSet.add(chunkIndex);
    receivedChunkSets.set(uploadId, receivedSet);
    activeUploadsByRoom.set(roomId, uploadId);

    const progress = computeUploadProgress(meta, receivedSet);
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
    const authError = ensureUploadAuthorized(roomId, auth.token, auth.hostId, deps);
    if (authError) { res.status(authError.status).json({ error: authError.error }); return; }

    const { filename, totalChunks } = body;

    const chunksDir = join(deps.uploadsDir, uploadId);
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    
    const meta = metaCache.get(uploadId);
    if (!meta || meta.roomId !== roomId) {
      res.status(400).json({ error: "Upload inválido" });
      return;
    }

    const receivedSet = receivedChunkSets.get(uploadId);
    if (!receivedSet || receivedSet.size !== totalChunks) {
      res.status(400).json({ error: "Upload incompleto", received: receivedSet?.size || 0, expected: totalChunks });
      return;
    }

    const finalPath = join(deps.uploadsDir, `${uploadId}_${safeFilename}`);
    const partPath = getPartPath(chunksDir);
    
    // Close file handle and sync metadata before finalizing
    await closeUploadHandle(uploadId);
    await syncMetaToDisk(uploadId);
    clearMetaCache(uploadId);
    
    await fs.rename(partPath, finalPath);
    await removeUpload(chunksDir);

    if (activeUploadsByRoom.get(roomId) === uploadId) {
      activeUploadsByRoom.delete(roomId);
    }

    // Start Async Processing
    // We send response immediately so client doesn't timeout, but we keep room in "Processing" state
    deps.roomManager.updateState(roomId, { 
        isUploading: false, 
        uploadProgress: 100, 
        isProcessing: true, 
        processingMessage: "Iniciando pós-processamento..." 
    });
    
    // Send immediate response
    res.json({ success: true, filename: safeFilename, processing: true });

    // Background Task
    (async () => {
        try {
            const processor = new MediaProcessor(deps.roomManager);
            const processedPath = await processor.processMedia(roomId, finalPath);
            
            deps.roomManager.setVideoPath(roomId, processedPath);
            deps.roomManager.updateState(roomId, { 
                isProcessing: false, 
                processingMessage: '' 
            });
            deps.roomManager.broadcastAll(roomId, { type: "video-ready" });
        } catch (err) {
            console.error(`[Upload] Error processing media for room ${roomId}:`, err);
            deps.roomManager.updateState(roomId, { 
                isProcessing: false, 
                processingMessage: 'Erro no processamento' 
            });
            // Optionally broadcast error
        }
    })();
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
    const authError = ensureUploadAuthorized(roomId, auth.token, auth.hostId, deps);
    if (authError) { res.status(authError.status).json({ error: authError.error }); return; }

    const { uploadId } = body;

    // Mantém compatibilidade: este endpoint serve para atualizar lastActivity/keep-alive,
    // mas o progresso deve ser derivado dos chunks recebidos no servidor.
    const effectiveUploadId = uploadId || activeUploadsByRoom.get(roomId);

    if (effectiveUploadId) {
      const chunksDir = join(deps.uploadsDir, effectiveUploadId);
      if (existsSync(chunksDir)) {
        activeUploadsByRoom.set(roomId, effectiveUploadId);
        markActivity(chunksDir, effectiveUploadId).catch(console.error);

        const meta = metaCache.get(effectiveUploadId) || await getOrLoadMeta(chunksDir, effectiveUploadId);
        if (meta && meta.roomId === roomId) {
          const receivedSet = receivedChunkSets.get(effectiveUploadId) || new Set(meta.receivedChunks || []);
          receivedChunkSets.set(effectiveUploadId, receivedSet);

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

  router.post("/subtitle/:roomId", async (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const room = deps.roomManager.getRoom(roomId);
    if (!room) {
      res.status(404).json({ error: "Sala não encontrada" });
      return;
    }

    const auth = getAuthFromRequest(req);
    const authError = ensureUploadAuthorized(roomId, auth.token, auth.hostId, deps);
    if (authError) { res.status(authError.status).json({ error: authError.error }); return; }

    const subtitlesDir = getSubtitlesDir(deps.uploadsDir, roomId);
    if (!existsSync(subtitlesDir)) {
      mkdirSync(subtitlesDir, { recursive: true });
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    const rawFilename = (req.headers["x-filename"] as string) || "subtitle.srt";
    const safeFilename = basename(rawFilename).replace(/[^a-zA-Z0-9._-]/g, "_");
    const displayName = rawFilename.replace(/\.srt$/i, "");
    const filePath = join(subtitlesDir, safeFilename);

    await fs.writeFile(filePath, buffer);
    deps.roomManager.addSubtitle(roomId, safeFilename, displayName);

    deps.roomManager.broadcastAll(roomId, {
      type: "subtitle-added",
      filename: safeFilename,
    });

    res.json({ success: true, filename: safeFilename, displayName });
  });

  router.get("/subtitles/:roomId", (req, res) => {
    const roomId = req.params.roomId as string;
    const room = deps.roomManager.getRoom(roomId);
    if (!room) {
      res.status(404).json({ error: "Sala não encontrada" });
      return;
    }

    const subtitles = deps.roomManager.getSubtitles(roomId);
    res.json({ subtitles });
  });

  router.get("/subtitle/:roomId/:filename", async (req, res) => {
    const roomId = req.params.roomId as string;
    const room = deps.roomManager.getRoom(roomId);
    if (!room) {
      res.status(404).json({ error: "Sala não encontrada" });
      return;
    }

    const subtitlesDir = getSubtitlesDir(deps.uploadsDir, roomId);
    const filename = basename(req.params.filename);
    const filePath = join(subtitlesDir, filename);

    if (!filePath.startsWith(subtitlesDir)) {
      res.status(400).json({ error: "Filename inválido" });
      return;
    }

    if (!existsSync(filePath)) {
      res.status(404).json({ error: "Legenda não encontrada" });
      return;
    }

    try {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      const buffer = await fs.readFile(filePath);
      const content = decodeSubtitleBuffer(buffer);
      res.send(content);
    } catch (e) {
      console.error(`[Upload] Failed to read subtitle ${filePath}:`, e);
      res.status(500).json({ error: "Erro ao ler legenda" });
    }
  });

  router.delete("/subtitle/:roomId/:filename", async (req, res) => {
    const roomId = req.params.roomId as string;
    const room = deps.roomManager.getRoom(roomId);
    if (!room) {
      res.status(404).json({ error: "Sala não encontrada" });
      return;
    }

    const auth = getAuthFromRequest(req);
    const authError = ensureUploadAuthorized(roomId, auth.token, auth.hostId, deps);
    if (authError) { res.status(authError.status).json({ error: authError.error }); return; }

    const subtitlesDir = getSubtitlesDir(deps.uploadsDir, roomId);
    const filename = basename(req.params.filename);
    const filePath = join(subtitlesDir, filename);

    if (!filePath.startsWith(subtitlesDir)) {
      res.status(400).json({ error: "Filename inválido" });
      return;
    }

    if (existsSync(filePath)) {
      try {
        await rm(filePath, { force: true });
      } catch (e) {
        console.error(`[Upload] Failed to delete subtitle ${filePath}:`, e);
      }
    }
    deps.roomManager.removeSubtitle(roomId, filename);

    res.json({ success: true });
  });

  return router;
}
