import type { Room, WSMessage, ExtendedWebSocket, DiscordUser } from "../shared/types";
import { logger } from "../shared/logger";

function sendToSockets(
    sockets: Iterable<ExtendedWebSocket>,
    data: string,
    errorMessage: string,
    exclude?: ExtendedWebSocket
): void {
    for (const client of sockets) {
        if (client !== exclude && client.readyState === WebSocket.OPEN) {
            try {
                client.send(data);
            } catch (e) {
                logger.error("Room", errorMessage, e);
            }
        }
    }
}

export function broadcast(room: Room, message: WSMessage | string, exclude?: ExtendedWebSocket): void {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    sendToSockets(room.clients, data, "Falha ao enviar mensagem ao cliente", exclude);
    sendToSockets(room.observers, data, "Falha ao enviar mensagem ao observador", exclude);
}

export function broadcastAll(room: Room, message: WSMessage | string): void {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    sendToSockets(room.clients, data, "Falha ao enviar mensagem ao cliente");
    sendToSockets(room.observers, data, "Falha ao enviar mensagem ao observador");
}

export function broadcastViewerCount(room: Room, connectedUsers: DiscordUser[]): void {
    const message = JSON.stringify({
        type: "viewers",
        count: connectedUsers.length,
        viewers: connectedUsers.map(u => ({
            discordId: u.discordId,
            username: u.username,
            avatarUrl: u.avatarUrl,
            ping: u.ping
        }))
    });

    sendToSockets(room.clients, message, "Falha ao enviar contagem de viewers");
    sendToSockets(room.observers, message, "Falha ao enviar contagem de viewers ao observador");
}
