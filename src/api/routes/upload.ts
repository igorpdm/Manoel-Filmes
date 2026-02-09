import { Router } from "express";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, promises as fs } from "fs";
import { rm } from "fs/promises";
import { join, basename } from "path";
import type { Request, Response } from "express";
import { MediaProcessor } from "../services/media-processor";
import { logger } from "../../shared/logger";
import type { UploadDeps, UploadMeta } from "./upload-types";
import { getAuthFromRequest, ensureUploadAuthorized } from "./upload-auth";
import {
  decodeSubtitleBuffer,
  getPartPath,
  getSubtitlesDir,
  listRoomUploadDirs,
  sanitizeUploadFilename,
} from "./upload-paths";

const activeUploadsByRoom = new Map<string, string>();
const UPLOAD_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL = 5 * 60 * 1000;

// Cache de handles de arquivo abertos: uploadId -> { handle, lastUsed }
const fileHandleCache = new Map<string, { handle: fs.FileHandle, lastUsed: number }>();
const HANDLE_TTL_MS = 60000; // Fecha handle após 60s sem atividade.
const activeWriteCounts = new Map<string, number>();

// Cache de metadados em memória para reduzir I/O durante o upload.
const metaCache = new Map<string, UploadMeta>();
const receivedChunkSets = new Map<string, Set<number>>();
const metaLoadPromises = new Map<string, Promise<UploadMeta | null>>();
const uploadDirsById = new Map<string, string>();

// Progresso deve ser calculado pelo servidor a partir dos chunks recebidos.
// Limita a frequência de broadcast para não inundar o WS em uploads rápidos.
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
      logger.error("UploadRoute", `Falha ao fechar handle do upload ${uploadId}`, e);
    }
    fileHandleCache.delete(uploadId);
  }
}

async function getOrLoadMeta(chunksDir: string, uploadId: string): Promise<UploadMeta | null> {
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

// Sincroniza metadados em disco somente em init, complete e abort.
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

// Fecha handles ociosos periodicamente para evitar acúmulo de descritores.
setInterval(async () => {
  const now = Date.now();
  for (const [uploadId, cached] of fileHandleCache.entries()) {
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
      logger.error("UploadRoute", `Falha ao remover pasta de upload ${chunksDir}`, e);
    }
  }
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
    
    let meta: UploadMeta | null = metaCache.get(uploadId) ?? null;
    
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
      await closeUploadHandle(uploadId);
      clearMetaCache(uploadId);
      await removeUpload(dirPath);
    }
  }
}

/**
 * Inicia limpeza periódica de uploads temporários expirados.
 * @param uploadsDir Diretório base de uploads.
 * @returns Nada.
 */
export function startUploadCleanup(uploadsDir: string) {
  setInterval(() => cleanupUploads(uploadsDir), CLEANUP_INTERVAL);
}

/**
 * Remove arquivos temporários de upload e legendas de uma sala.
 * @param uploadsDir Diretório base de uploads.
 * @param roomId Identificador da sala.
 * @returns Promise finalizada após a limpeza.
 * @throws Pode lançar erro de infraestrutura de sistema de arquivos.
 */
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
      logger.error("UploadRoute", `Falha ao remover pasta de legendas ${subtitlesDir}`, e);
    }
  }
}

/**
 * Cria rotas HTTP para upload em chunks, retomada e legendas.
 * @param deps Dependências para autorização e gestão de estado da sala.
 * @returns Instância de router com endpoints de upload.
 * @throws Retorna erros HTTP de validação, autorização e infraestrutura.
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

    if (room.state.isProcessing) {
      res.status(409).json({ error: "Aguarde o processamento atual terminar antes de enviar outro vídeo" });
      return;
    }

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
    const safeFilename = sanitizeUploadFilename(filename);
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
      logger.error("UploadRoute", `Falha ao escrever chunk ${chunkIndex} do upload ${uploadId}`, e);
      const remaining = (activeWriteCounts.get(uploadId) || 1) - 1;
      if (remaining <= 0) {
        activeWriteCounts.delete(uploadId);
      } else {
        activeWriteCounts.set(uploadId, remaining);
      }
      res.status(500).json({ error: "Erro ao escrever dados" });
      return;
    }

    const remaining = (activeWriteCounts.get(uploadId) || 1) - 1;
    if (remaining <= 0) {
      activeWriteCounts.delete(uploadId);
    } else {
      activeWriteCounts.set(uploadId, remaining);
    }

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
    const safeFilename = sanitizeUploadFilename(filename);
    
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
    
    // Garante consistência em disco antes de finalizar o arquivo.
    await closeUploadHandle(uploadId);
    await syncMetaToDisk(uploadId);
    clearMetaCache(uploadId);
    
    await fs.rename(partPath, finalPath);
    await removeUpload(chunksDir);

    if (activeUploadsByRoom.get(roomId) === uploadId) {
      activeUploadsByRoom.delete(roomId);
    }

    // Responde imediatamente para evitar timeout do cliente e mantém a sala em processamento.
    const initialProcessingMessage = "Iniciando pós-processamento...";

    deps.roomManager.updateState(roomId, { 
        isUploading: false, 
        uploadProgress: 100, 
        isProcessing: true, 
        processingMessage: initialProcessingMessage 
    });
    deps.roomManager.broadcastAll(roomId, {
      type: "processing-progress",
      processingMessage: initialProcessingMessage
    });
    
    res.json({ success: true, filename: safeFilename, processing: true });

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
            logger.error("UploadRoute", `Falha ao processar mídia da sala ${roomId}`, err);
            deps.roomManager.updateState(roomId, { 
                isProcessing: false, 
                processingMessage: 'Erro no processamento' 
            });
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

    // Mantém compatibilidade: este endpoint serve para atualizar lastActivity/sinal de atividade,
    // mas o progresso deve ser derivado dos chunks recebidos no servidor.
    const effectiveUploadId = uploadId || activeUploadsByRoom.get(roomId);

    if (effectiveUploadId) {
      const chunksDir = join(deps.uploadsDir, effectiveUploadId);
      if (existsSync(chunksDir)) {
        activeUploadsByRoom.set(roomId, effectiveUploadId);
        markActivity(chunksDir, effectiveUploadId).catch((error) => {
          logger.error("UploadRoute", `Falha ao marcar atividade do upload ${effectiveUploadId}`, error);
        });

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
    const safeFilename = sanitizeUploadFilename(basename(rawFilename));
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
      logger.error("UploadRoute", `Falha ao ler legenda ${filePath}`, e);
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
        logger.error("UploadRoute", `Falha ao remover legenda ${filePath}`, e);
      }
    }
    deps.roomManager.removeSubtitle(roomId, filename);

    res.json({ success: true });
  });

  return router;
}
