import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { existsSync, statSync, mkdirSync, createReadStream } from "fs";
import { join, resolve } from "path";
import cors from "cors"; // Although not strictly used in original, good to have.
import { roomManager } from "../core/room-manager";
import type { ClientData, WSMessage, ExtendedWebSocket, MovieInfo, SelectedEpisode } from "../shared/types";
import { handleWebSocketMessage } from "./websocket-handler";
import { logger } from "../shared/logger";

import { createTmdbRouter } from "./routes/tmdb";
import { createDiscordSessionRouter } from "./routes/discord-session";
import { createUploadRouter, startUploadCleanup, cleanupRoomUploads } from "./routes/upload";
import { buildSessionStatusData } from "./services/session-status";
import { sendRouteError } from "./http/route-error";
import { ConflictHttpError, ForbiddenHttpError, NotFoundHttpError, ValidationHttpError } from "./http/http-error";
import { optionalString, requireNonEmptyString, requireObject } from "./http/validation";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { 
    PORT, 
    PUBLIC_DIR, 
    UPLOADS_DIR, 
    IS_PROD, 
    TMDB_API_KEY, 
    TMDB_BASE_URL, 
    TMDB_IMAGE_BASE 
} from "../config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

if (!TMDB_API_KEY) {
    logger.warn("Config", "⚠️  TMDB_API_KEY não encontrada! Verifique seu arquivo .env");
} else {
    logger.success("Config", "✅ TMDB API Key carregada com sucesso");
}

const VIDEO_CHUNK_SIZE = 4 * 1024 * 1024;
const STATIC_CACHE_MAX_AGE = 14400;
const SYNC_TICK_INTERVAL = 3000;

if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
}

startUploadCleanup(UPLOADS_DIR);

const MIME_TYPES: Record<string, string> = {
    html: "text/html",
    css: "text/css",
    js: "application/javascript",
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    mov: "video/quicktime",
    m4v: "video/x-m4v",
    ogg: "video/ogg",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
};

function getMimeType(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase();
    return MIME_TYPES[ext || ""] || "application/octet-stream";
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Rate Limiting
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 120;
const RATE_WINDOW = 60000;

function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const entry = rateLimitMap.get(ip);

    if (!entry || now > entry.resetTime) {
        rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
        return next();
    }

    if (entry.count >= RATE_LIMIT && !req.url.startsWith("/api/upload/")) {
        res.status(429).json({ error: "Too many requests" });
        return;
    }

    entry.count++;
    next();
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
        if (now > entry.resetTime) {
            rateLimitMap.delete(ip);
        }
    }
}, 60000);

// CORS Configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").filter(Boolean) || [];
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    credentials: true
}));
app.use(express.json());

const getSessionStatusData = (roomId: string) => buildSessionStatusData(roomManager, roomId);

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

// Routes
const tmdbDeps = { apiKey: TMDB_API_KEY || "", baseUrl: TMDB_BASE_URL, imageBase: TMDB_IMAGE_BASE };
app.use("/api", createTmdbRouter(tmdbDeps));

const discordSessionDeps = { roomManager, getSessionStatusData, uploadsDir: UPLOADS_DIR };
app.use("/api", createDiscordSessionRouter(discordSessionDeps));

const uploadDeps = { roomManager, uploadsDir: UPLOADS_DIR };
app.use("/api/upload", createUploadRouter(uploadDeps));

// API Routes formerly in manual handler
app.post("/api/create-room", rateLimit, async (req, res) => {
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
            if (payload.movieInfo) {
                room.movieInfo = payload.movieInfo;
            }
            if (payload.selectedEpisode) {
                room.selectedEpisode = payload.selectedEpisode;
            }
        }

        const hostId = roomManager.getHostId(roomId);
        logger.info("API", `Sala criada: room=${roomId} host=${hostId}`);
        res.json({ roomId, hostId, url: `/room/${roomId}` });
    } catch (error) {
        sendRouteError(res, error, "APIServer");
    }
});

app.get("/api/room-info/:roomId", (req, res) => {
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
        selectedEpisode: room.selectedEpisode || null
    });
});

app.post("/api/end-session/:roomId", async (req, res) => {
    try {
        const { roomId } = req.params;
        const payload = requireObject(req.body);
        const hostId = requireNonEmptyString(payload.hostId, "hostId");

        const room = roomManager.getRoom(roomId);
        if (!room) {
            throw new NotFoundHttpError("Sala não encontrada");
        }

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

app.get("/api/room-status/:roomId", (req, res) => {
    const { roomId } = req.params;
    const room = roomManager.getRoom(roomId);
    if (!room) {
        res.status(404).json({ error: "Sala não encontrada" });
        return;
    }
    res.json({
        hasVideo: room.state.videoPath !== '',
        isUploading: room.state.isUploading,
        uploadProgress: room.state.uploadProgress,
        isProcessing: room.state.isProcessing,
        processingMessage: room.state.processingMessage
    });
});

// Video Streaming Route
app.get("/video/:roomId", (req, res) => {
    const { roomId } = req.params;
    const room = roomManager.getRoom(roomId);
    if (!room || !room.state.videoPath) {
        res.status(404).send("Vídeo não encontrado");
        return;
    }

    const videoPath = room.state.videoPath;
    if (!existsSync(videoPath)) {
        res.status(404).send("Vídeo não encontrado");
        return;
    }

    const stat = statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const requestedEnd = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const end = Math.min(start + VIDEO_CHUNK_SIZE - 1, requestedEnd, fileSize - 1);
        const chunkSize = end - start + 1;

        const file = createReadStream(videoPath, { start, end });
        const head = {
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": chunkSize,
            "Content-Type": getMimeType(videoPath),
            "Cache-Control": "no-cache"
        };
        res.writeHead(206, head);
        file.pipe(res);

        req.on("close", () => {
            file.destroy();
        });
    } else {
        const head = {
            "Content-Length": fileSize,
            "Content-Type": getMimeType(videoPath),
            "Accept-Ranges": "bytes",
        };
        res.writeHead(200, head);
        const file = createReadStream(videoPath);
        file.pipe(res);

        req.on("close", () => {
            file.destroy();
        });
    }
});

// Serve frontend files
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
    res.status(403).send("Acesso restrito. Use o bot do Discord para criar sessões.");
});
app.get("/index.html", (req, res) => {
    res.status(403).send("Acesso restrito. Use o bot do Discord para criar sessões.");
});

app.get("/room/:roomId", (req, res) => {
    const { roomId } = req.params;
    const room = roomManager.getRoom(roomId);
    if (!room) {
        res.status(404).send("Sala não encontrada");
        return;
    }
    res.sendFile(join(PUBLIC_DIR, "room.html"));
});

// WebSocket Upgrade Handling
server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    if (url.pathname === '/ws') {
        const roomId = url.searchParams.get('room');
        const clientId = url.searchParams.get('clientId') || '';
        const token = url.searchParams.get('token') || '';

        if (!roomId || !roomManager.getRoom(roomId)) {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
        }

        const room = roomManager.getRoom(roomId);
        let discordUser = null;

        if (room?.discordSession && token) {
            discordUser = roomManager.validateToken(roomId, token);
            if (!discordUser) {
                socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                socket.destroy();
                return;
            }
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
            const extWs = ws as ExtendedWebSocket;
            extWs.data = { roomId, clientId, token, discordUser: discordUser || undefined };
            wss.emit('connection', extWs, request);
        });
    } else {
        socket.destroy();
    }
});

// WebSocket Connection Handling
wss.on('connection', (ws: ExtendedWebSocket) => {
    const { roomId, clientId, token } = ws.data;
    const room = roomManager.getRoom(roomId);
    logger.info("WS", `Conexão aberta: room=${roomId} client=${clientId} token=${token ? "sim" : "não"}`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let isHost = roomManager.isHost(roomId, clientId);

    if (token) {
        roomManager.markUserConnected(roomId, token);
        isHost = roomManager.isHostByToken(roomId, token);
    }

    const added = roomManager.addClient(roomId, ws);
    if (!added) {
        logger.warn("WS", `Conexão rejeitada (Sala cheia ou limite de banda): room=${roomId}`);
        ws.close(4003, "Room full or bandwidth limit exceeded");
        return;
    }

    if (isHost) {
        roomManager.updateHostHeartbeat(roomId);
    }

    // Initial state send
    if (room) {
        const currentTime = roomManager.getCurrentTime(roomId);
        ws.send(JSON.stringify({
            type: "sync",
            currentTime,
            isPlaying: room.state.isPlaying,
            isHost,
        }));

        if (room.state.isUploading && isHost) {
            ws.send(JSON.stringify({
                type: "upload-progress",
                progress: room.state.uploadProgress,
            }));
        }

        if (room.state.isProcessing && isHost) {
             ws.send(JSON.stringify({
                type: "processing-progress",
                processingMessage: room.state.processingMessage
             }));
        }

        const statusData = getSessionStatusData(roomId);
        if (statusData) {
            ws.send(JSON.stringify({ type: "session-status", ...statusData }));
        }
    }

    ws.on('message', (message) => {
        handleWebSocketMessage(ws, message);
    });

    ws.on('close', () => {
        const { roomId } = ws.data;
        logger.info("WS", `Conexão fechada: room=${roomId}`);
        roomManager.removeClient(roomId, ws);
    });
});

const HOST_CHECK_INTERVAL = 15000;

setInterval(() => {
    roomManager.forEachRoom(room => {
        if (!room.discordSession) return;
        if (room.clients.size === 0) return;
        if (room.status === 'ended') return;

        if (roomManager.isHostInactive(room.id)) {
            const newHost = roomManager.transferHost(room.id);
            if (newHost) {
                logger.warn("HostTransfer", `Host inativo - transferindo para ${newHost.newHostUsername}`);
                roomManager.broadcastAll(room.id, {
                    type: "host-changed",
                    newHostId: newHost.newHostId,
                    newHostUsername: newHost.newHostUsername
                });
            }
        }
    });
}, HOST_CHECK_INTERVAL);

const GLOBAL_TICK_MS = 1000;
const roomLastSync = new Map<string, number>();

setInterval(() => {
    const serverTime = Date.now();
    roomManager.forEachRoom(room => {
        if (room.clients.size === 0) return;
        
        // Dynamic Sync Rate Check
        const lastSync = roomLastSync.get(room.id) || 0;
        const interval = roomManager.getSyncInterval(room.id);
        
        if (serverTime - lastSync < interval) return;

        if (!room.state.playbackStarted) return;
        
        // Update sync timestamp
        roomLastSync.set(room.id, serverTime);

        // Only sync if playing, or if it's been a long time (keep alive state)
        if (room.state.isPlaying || (serverTime - lastSync > 5000)) {
            const currentTime = roomManager.getCurrentTime(room.id);
            roomManager.broadcastAll(room.id, {
                type: "sync",
                currentTime,
                isPlaying: room.state.isPlaying,
                serverTime // Backend adds serverTime for latency compensation
            });
        }
    });
}, GLOBAL_TICK_MS);

const HEARTBEAT_INTERVAL = 30000;

setInterval(() => {
    wss.clients.forEach((ws) => {
        const extWs = ws as ExtendedWebSocket;
        if (extWs.isAlive === false) {
            return ws.terminate();
        }
        extWs.isAlive = false;
        ws.ping();
    });
}, HEARTBEAT_INTERVAL);

async function gracefulShutdown() {
    logger.info("Server", "Shutting down gracefully...");

    wss.clients.forEach((ws) => {
        try {
            ws.close(1001, "Server shutting down");
        } catch (e) {
            logger.error("Server", "Error closing WebSocket:", e);
        }
    });

    server.close(() => {
        logger.success("Server", "HTTP server closed");
        process.exit(0);
    });

    setTimeout(() => {
        logger.error("Server", "Forced shutdown after timeout");
        process.exit(1);
    }, 10000);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

server.listen(PORT, () => {
    if (!IS_PROD) {
        logger.success("Server", `🎬 Servidor rodando em http://localhost:${PORT}`);
    }
});
