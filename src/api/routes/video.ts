import { Router } from "../http/context";
import { existsSync, statSync } from "fs";
import { roomManager } from "../../core/room-manager";
import { requireRoomAccess } from "../http/room-access";
import { sendRouteError } from "../http/route-error";

const VIDEO_CHUNK_SIZE = 4 * 1024 * 1024;

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

/**
 * Cria rota de streaming de vídeo com suporte a range requests.
 * @returns Router com endpoint GET /video/:roomId.
 */
export function createVideoRouter(): Router {
    const router = Router();

    router.get("/:roomId", async (req, res) => {
        try {
            const { roomId } = req.params;
            const { room } = requireRoomAccess(roomManager, roomId, req);
            if (!room.state.videoPath) {
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
            const contentType = getMimeType(videoPath);

            if (range) {
                const match = range.match(/^bytes=(\d*)-(\d*)$/);
                if (!match) {
                    res.status(416).send("Range inválido");
                    return;
                }

                const [, rawStart, rawEnd] = match;
                const parsedStart = rawStart ? Number.parseInt(rawStart, 10) : Math.max(fileSize - Number.parseInt(rawEnd || "0", 10), 0);
                const requestedEnd = rawEnd && rawStart ? Number.parseInt(rawEnd, 10) : fileSize - 1;
                const start = parsedStart;

                if (!Number.isInteger(start) || start < 0 || start >= fileSize || requestedEnd < start) {
                    res.status(416).send("Range inválido");
                    return;
                }

                const safeRequestedEnd = Number.isInteger(requestedEnd) ? requestedEnd : fileSize - 1;
                const end = Math.min(start + VIDEO_CHUNK_SIZE - 1, safeRequestedEnd, fileSize - 1);
                const chunkSize = end - start + 1;

                res.respond(new Response(Bun.file(videoPath).slice(start, end + 1), {
                    status: 206,
                    headers: {
                        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                        "Accept-Ranges": "bytes",
                        "Content-Length": String(chunkSize),
                        "Content-Type": contentType,
                        "Cache-Control": "no-cache",
                    },
                }));
                return;
            }

            res.respond(new Response(Bun.file(videoPath), {
                status: 200,
                headers: {
                    "Content-Length": String(fileSize),
                    "Content-Type": contentType,
                    "Accept-Ranges": "bytes",
                },
            }));
        } catch (error) {
            sendRouteError(res, error, "VideoRoute");
        }
    });

    return router;
}
