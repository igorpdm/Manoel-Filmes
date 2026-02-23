import { Router } from "express";
import { join } from "path";
import { roomManager } from "../../core/room-manager";
import { PUBLIC_DIR } from "../../config";

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
        const { roomId } = req.params;
        const room = roomManager.getRoom(roomId);
        if (!room) {
            res.status(404).send("Sala não encontrada");
            return;
        }
        res.sendFile(join(PUBLIC_DIR, "room.html"));
    });

    return router;
}
