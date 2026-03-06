import { Router } from "express";
import { join } from "path";
import { roomManager } from "../../core/room-manager";
import { PUBLIC_DIR } from "../../config";
import { isHttpError } from "../http/http-error";
import { requireRoomAccess } from "../http/room-access";

/**
 * Cria rotas que servem o frontend estático e as páginas de sala.
 * @returns Router com endpoints de frontend e bloqueio de acesso direto.
 */
export function createStaticRouter(): Router {
    const router = Router();

    router.get("/", (_req, res) => {
        res.status(403).send("Acesso restrito. Use o bot do Discord para criar sessões.");
    });

    router.get("/index.html", (_req, res) => {
        res.status(403).send("Acesso restrito. Use o bot do Discord para criar sessões.");
    });

    router.get("/room/:roomId", (req, res) => {
        try {
            const { roomId } = req.params;
            requireRoomAccess(roomManager, roomId, req);
            res.sendFile(join(PUBLIC_DIR, "room.html"));
        } catch (error) {
            if (isHttpError(error)) {
                res.status(error.statusCode).send(error.message);
                return;
            }

            res.status(500).send("Erro interno do servidor");
        }
    });

    return router;
}
