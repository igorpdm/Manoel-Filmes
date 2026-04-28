import { existsSync, mkdirSync } from "fs";
import { promises as fs } from "fs";
import { rm } from "fs/promises";
import { basename, join } from "path";
import type { Request, Response, Router } from "../http/context";
import { requireRoomAccess } from "../http/room-access";
import { logger } from "../../shared/logger";
import { isPathInsideDirectory } from "../../shared/path-containment";
import type { UploadDeps } from "./upload-types";
import { getAuthFromRequest, ensureUploadAuthorized } from "./upload-auth";
import { decodeSubtitleBuffer, getSubtitlesDir, sanitizeUploadFilename } from "./upload-paths";

const MAX_SUBTITLE_SIZE_BYTES = 2 * 1024 * 1024;

export async function removeRoomSubtitles(deps: UploadDeps, roomId: string): Promise<void> {
    const subtitlesDir = getSubtitlesDir(deps.uploadsDir, roomId);
    if (existsSync(subtitlesDir)) {
        try {
            await rm(subtitlesDir, { recursive: true, force: true });
        } catch (error) {
            logger.error("UploadRoute", `Falha ao remover legendas da sala ${roomId}`, error);
        }
    }

    const room = deps.roomManager.getRoom(roomId);
    if (room && room.state.subtitles.length > 0) {
        deps.roomManager.updateState(roomId, { subtitles: [] });
    }
}

export function registerSubtitleRoutes(router: Router, deps: UploadDeps): void {
    router.post("/subtitle/:roomId", async (req: Request, res: Response) => {
        const roomId = req.params.roomId as string;
        const room = deps.roomManager.getRoom(roomId);
        if (!room) {
            res.status(404).json({ error: "Sala não encontrada" });
            return;
        }

        const auth = getAuthFromRequest(req);
        const authError = ensureUploadAuthorized(roomId, auth.token, deps);
        if (authError) { res.status(authError.status).json({ error: authError.error }); return; }

        const subtitlesDir = getSubtitlesDir(deps.uploadsDir, roomId);
        if (!existsSync(subtitlesDir)) {
            mkdirSync(subtitlesDir, { recursive: true });
        }

        const chunks: Buffer[] = [];
        let totalSubtitleBytes = 0;
        for await (const chunk of req) {
            totalSubtitleBytes += chunk.length;
            if (totalSubtitleBytes > MAX_SUBTITLE_SIZE_BYTES) {
                res.status(413).json({ error: "Legenda excede o tamanho máximo permitido" });
                return;
            }
            chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        const rawFilename = (req.headers["x-filename"] as string) || "subtitle.srt";
        const originalFilename = basename(rawFilename);
        const safeFilename = sanitizeUploadFilename(originalFilename);
        const displayName = originalFilename.replace(/\.srt$/i, "");
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
        try {
            const roomId = req.params.roomId as string;
            requireRoomAccess(deps.roomManager, roomId, req);
            const subtitles = deps.roomManager.getSubtitles(roomId);
            res.json({ subtitles });
        } catch (error) {
            logger.error("UploadRoute", "Falha ao listar legendas", error);
            res.status(403).json({ error: "Sem permissão para acessar legendas" });
        }
    });

    router.get("/subtitle/:roomId/:filename", async (req, res) => {
        const roomId = req.params.roomId as string;

        try {
            requireRoomAccess(deps.roomManager, roomId, req);
        } catch (error) {
            logger.error("UploadRoute", "Falha ao carregar legenda", error);
            res.status(403).json({ error: "Sem permissão para acessar legenda" });
            return;
        }

        const subtitlesDir = getSubtitlesDir(deps.uploadsDir, roomId);
        const filename = basename(req.params.filename);
        const filePath = join(subtitlesDir, filename);

        if (!isPathInsideDirectory(subtitlesDir, filePath)) {
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
        const authError = ensureUploadAuthorized(roomId, auth.token, deps);
        if (authError) { res.status(authError.status).json({ error: authError.error }); return; }

        const subtitlesDir = getSubtitlesDir(deps.uploadsDir, roomId);
        const filename = basename(req.params.filename);
        const filePath = join(subtitlesDir, filename);

        if (!isPathInsideDirectory(subtitlesDir, filePath)) {
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
}
