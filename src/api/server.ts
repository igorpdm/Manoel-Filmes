import { existsSync, mkdirSync } from "fs";
import { extname, resolve, sep } from "path";

import { attachOAuthSession } from "./http/session-middleware";
import { createCorsPreflightResponse, withCors } from "./http/cors";
import { dispatchRequest, type MountedRouter } from "./http/context";
import { createTmdbRouter } from "./routes/tmdb";
import { createDiscordSessionRouter } from "./routes/discord-session";
import { createOAuthRouter } from "./routes/oauth";
import { createUploadRouter, startUploadCleanup } from "./routes/upload";
import { clearAllUploads } from "./routes/upload-cleanup";
import { createRoomRouter, getSessionStatusData } from "./routes/room";
import { createVideoRouter } from "./routes/video";
import { createStaticRouter } from "./routes/static";
import {
    closeAllWebSockets,
    handleWebSocketUpgrade,
    setupWebSocketServer,
    websocketHandlers,
} from "./websocket-server";
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
    SESSION_SECRET,
} from "../config";

const STATIC_MIME_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".wgsl": "text/plain; charset=utf-8",
};

if (!TMDB_API_KEY) {
    logger.warn("Config", "TMDB_API_KEY não encontrada. Verifique seu arquivo .env");
} else {
    logger.success("Config", "TMDB API Key carregada com sucesso");
}

if (!PLAYER_API_SHARED_SECRET) {
    throw new Error("PLAYER_API_SHARED_SECRET ausente. Verifique seu arquivo .env");
}

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET ausente ou muito curto (mínimo 32 caracteres). Verifique seu arquivo .env");
}

if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
}

await clearAllUploads(UPLOADS_DIR);
startUploadCleanup(UPLOADS_DIR);

const tmdbDeps = { apiKey: TMDB_API_KEY || "", baseUrl: TMDB_BASE_URL, imageBase: TMDB_IMAGE_BASE };
const discordSessionDeps = { roomManager, getSessionStatusData, uploadsDir: UPLOADS_DIR };
const oauthDeps = { roomManager };

const mountedRouters: MountedRouter[] = [
    { prefix: "/api/upload", router: createUploadRouter({ roomManager, uploadsDir: UPLOADS_DIR }) },
    { prefix: "/api", router: createTmdbRouter(tmdbDeps) },
    { prefix: "/api", router: createDiscordSessionRouter(discordSessionDeps) },
    { prefix: "/api", router: createOAuthRouter(oauthDeps) },
    { prefix: "/api", router: createRoomRouter() },
    { prefix: "/video", router: createVideoRouter() },
    { prefix: "", router: createStaticRouter() },
];

setupWebSocketServer();

const server = Bun.serve({
    port: Number(PORT),
    websocket: websocketHandlers,
    async fetch(request, server) {
        const websocketResponse = handleWebSocketUpgrade(request, server);
        if (websocketResponse !== null) {
            return websocketResponse as Response;
        }

        if (request.method === "OPTIONS") {
            return createCorsPreflightResponse(request);
        }

        try {
            const ip = server.requestIP(request)?.address || "unknown";
            const routedResponse = await dispatchRequest(request, mountedRouters, ip, attachOAuthSession);
            if (routedResponse) {
                return withCors(request, routedResponse);
            }
        } catch (error) {
            if (error instanceof SyntaxError) {
                return withCors(request, new Response(JSON.stringify({ error: "JSON inválido" }), {
                    status: 400,
                    headers: { "Content-Type": "application/json; charset=utf-8" },
                }));
            }

            logger.error("Server", "Erro inesperado ao processar request", error);
            return withCors(request, new Response(JSON.stringify({ error: "Erro interno do servidor" }), {
                status: 500,
                headers: { "Content-Type": "application/json; charset=utf-8" },
            }));
        }

        const staticResponse = await servePublicAsset(request);
        return withCors(request, staticResponse || new Response("Not Found", { status: 404 }));
    },
});

async function servePublicAsset(request: Request): Promise<Response | null> {
    if (request.method !== "GET" && request.method !== "HEAD") return null;

    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);
    const publicRoot = resolve(PUBLIC_DIR);
    const filePath = resolve(publicRoot, `.${pathname}`);

    if (filePath !== publicRoot && !filePath.startsWith(publicRoot + sep)) {
        return new Response("Bad Request", { status: 400 });
    }

    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;

    const contentType = STATIC_MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
    const headers = new Headers({
        "Content-Type": contentType,
        "Cache-Control": contentType.startsWith("text/html") ? "no-cache" : "public, max-age=31536000, immutable",
    });

    return new Response(request.method === "HEAD" ? null : file, { status: 200, headers });
}

async function shutdown() {
    logger.info("Server", "Encerrando servidor...");
    closeAllWebSockets();
    server.stop(true);
    logger.success("Server", "Servidor Bun encerrado");
    process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

if (!IS_PROD) {
    logger.success("Server", `Servidor Bun rodando em http://localhost:${PORT}`);
}
