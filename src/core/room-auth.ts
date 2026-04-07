import { randomBytes } from "crypto";
import type { Room, DiscordUser, ClientMetrics } from "../shared/types";
import { logger } from "../shared/logger";

export function generateToken(): string {
    return randomBytes(32).toString("base64url");
}

export function validateToken(room: Room, token: string): DiscordUser | null {
    return room.tokenMap.get(token) || null;
}

export function generateUserToken(room: Room, discordId: string, username: string, avatarUrl: string | null = null): string {
    for (const [token, user] of room.tokenMap) {
        if (user.discordId === discordId) return token;
    }

    const token = generateToken();
    room.tokenMap.set(token, {
        discordId,
        username,
        avatarUrl,
        isHost: false,
        connected: false,
        connectedAt: 0,
        ping: -1
    });
    return token;
}

export function markUserConnected(room: Room, token: string): void {
    const user = room.tokenMap.get(token);
    if (!user) return;
    user.connected = true;
    if (user.connectedAt === 0) user.connectedAt = Date.now();
    logger.info("Room", `Usuário conectado: ${user.username} (Room: ${room.id})`);
}

export function markUserDisconnected(room: Room, token: string): void {
    const user = room.tokenMap.get(token);
    if (!user) return;
    user.connected = false;
    logger.info("Room", `Usuário desconectado: ${user.username} (Room: ${room.id})`);
}

export function getConnectedUsers(room: Room): DiscordUser[] {
    return Array.from(room.tokenMap.values()).filter(u => u.connected);
}

export function updateUserMetrics(room: Room, token: string, metrics: ClientMetrics): void {
    const user = room.tokenMap.get(token);
    if (user) user.ping = metrics.lastPing;
}

export function isHostByToken(room: Room, token: string): boolean {
    return room.tokenMap.get(token)?.isHost ?? false;
}

export function getOldestConnectedUser(room: Room): { token: string; user: DiscordUser } | null {
    let oldest: { token: string; user: DiscordUser } | null = null;

    for (const [token, user] of room.tokenMap) {
        if (!user.connected || user.isHost) continue;
        if (!oldest || user.connectedAt < oldest.user.connectedAt) {
            oldest = { token, user };
        }
    }

    return oldest;
}

export function transferHost(room: Room): { newHostId: string; newHostUsername: string; token: string } | null {
    if (!room.discordSession) return null;

    const oldest = getOldestConnectedUser(room);
    if (!oldest) return null;

    for (const user of room.tokenMap.values()) user.isHost = false;

    oldest.user.isHost = true;
    room.discordSession.hostDiscordId = oldest.user.discordId;
    room.state.hostLastHeartbeat = Date.now();

    return {
        newHostId: oldest.user.discordId,
        newHostUsername: oldest.user.username,
        token: oldest.token
    };
}
