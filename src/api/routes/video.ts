import { Router } from "express";
import { existsSync, statSync, createReadStream } from "fs";
import { roomManager } from "../../core/room-manager";

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

    router.get("/:roomId", (req, res) => {
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
            res.writeHead(206, {
                "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                "Accept-Ranges": "bytes",
                "Content-Length": chunkSize,
                "Content-Type": getMimeType(videoPath),
                "Cache-Control": "no-cache",
            });
            file.pipe(res);
            req.on("close", () => file.destroy());
        } else {
            const file = createReadStream(videoPath);
            res.writeHead(200, {
                "Content-Length": fileSize,
                "Content-Type": getMimeType(videoPath),
                "Accept-Ranges": "bytes",
            });
            file.pipe(res);
            req.on("close", () => file.destroy());
        }
    });

    return router;
}
