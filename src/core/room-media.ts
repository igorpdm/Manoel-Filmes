import { existsSync } from "fs";
import { rm } from "fs/promises";
import { UPLOADS_DIR } from "../config";
import { logger } from "../shared/logger";
import { isPathInsideDirectory } from "../shared/path-containment";
import type { Room } from "../shared/types";

export async function removeRoomMediaFiles(room: Room, context: string): Promise<void> {
    const mediaPaths = Array.from(new Set(
        [room.state.videoPath, room.state.pendingVideoPath].filter(Boolean)
    ));

    for (const mediaPath of mediaPaths) {
        if (!existsSync(mediaPath)) continue;
        if (!isPathInsideDirectory(UPLOADS_DIR, mediaPath)) {
            logger.warn("RoomManager", `Ignorando deleção de arquivo externo: ${mediaPath}`);
            continue;
        }

        try {
            await rm(mediaPath, { force: true });
            logger.info("RoomManager", `Arquivo de mídia removido (${context}): ${mediaPath}`);
        } catch (error) {
            logger.error("RoomManager", `Erro ao deletar arquivo de mídia (${context})`, error);
        }
    }
}
