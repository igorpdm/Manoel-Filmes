import { WebSocket } from "ws";
import type { Room, WSMessage, ExtendedWebSocket, DiscordUser } from "../shared/types";
import { logger } from "../shared/logger";

export function broadcast(room: Room, message: WSMessage | string, exclude?: ExtendedWebSocket): void {
    const data = typeof message === 'string' ? message : JSON.stringify(message);

    for (const client of room.clients) {
        if (client !== exclude && client.readyState === WebSocket.OPEN) {
            try {
                client.send(data);
            } catch (e) {
                logger.error("Room", "Falha ao enviar mensagem ao cliente", e);
            }
        }
    }
}

export function broadcastAll(room: Room, message: WSMessage | string): void {
    const data = typeof message === 'string' ? message : JSON.stringify(message);

    for (const client of room.clients) {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(data);
            } catch (e) {
                logger.error("Room", "Falha ao enviar mensagem ao cliente", e);
            }
        }
    }
}

export function broadcastViewerCount(room: Room, connectedUsers: DiscordUser[]): void {
    const message = JSON.stringify({
        type: "viewers",
        count: connectedUsers.length,
        viewers: connectedUsers.map(u => ({
            discordId: u.discordId,
            username: u.username,
            ping: u.ping
        }))
    });

    for (const client of room.clients) {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (e) {
                logger.error("Room", "Falha ao enviar contagem de viewers", e);
            }
        }
    }
}
