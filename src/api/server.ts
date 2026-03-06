import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { existsSync, mkdirSync } from "fs";

import { corsMiddleware } from "./http/cors";
import { createTmdbRouter } from "./routes/tmdb";
import { createDiscordSessionRouter } from "./routes/discord-session";
import { createUploadRouter, startUploadCleanup } from "./routes/upload";
import { createRoomRouter, getSessionStatusData } from "./routes/room";
import { createVideoRouter } from "./routes/video";
import { createStaticRouter } from "./routes/static";
import { setupWebSocketServer } from "./websocket-server";
import { roomManager } from "../core/room-manager";
import { logger } from "../shared/logger";
import {
    PORT,
    PUBLIC_DIR,
    UPLOADS_DIR,
    IS_PROD,
    PLAYER_API_SHARED_SECRET,
    TMDB_API_KEY,
    TMDB_BASE_URL,
    TMDB_IMAGE_BASE,
} from "../config";

if (!TMDB_API_KEY) {
    logger.warn("Config", "⚠️  TMDB_API_KEY não encontrada! Verifique seu arquivo .env");
} else {
    logger.success("Config", "✅ TMDB API Key carregada com sucesso");
}

if (!PLAYER_API_SHARED_SECRET) {
    throw new Error("PLAYER_API_SHARED_SECRET ausente. Verifique seu arquivo .env");
}

if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
}

startUploadCleanup(UPLOADS_DIR);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(corsMiddleware);
app.use(express.json());

const tmdbDeps = { apiKey: TMDB_API_KEY || "", baseUrl: TMDB_BASE_URL, imageBase: TMDB_IMAGE_BASE };
app.use("/api", createTmdbRouter(tmdbDeps));

const discordSessionDeps = { roomManager, getSessionStatusData, uploadsDir: UPLOADS_DIR };
app.use("/api", createDiscordSessionRouter(discordSessionDeps));

app.use("/api/upload", createUploadRouter({ roomManager, uploadsDir: UPLOADS_DIR }));
app.use("/api", createRoomRouter());
app.use("/video", createVideoRouter());

app.use(createStaticRouter());
app.use(express.static(PUBLIC_DIR));

setupWebSocketServer(wss, server);

async function shutdown() {
    logger.info("Server", "Encerrando servidor...");

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

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, () => {
    if (!IS_PROD) {
        logger.success("Server", `🎬 Servidor rodando em http://localhost:${PORT}`);
    }
});
