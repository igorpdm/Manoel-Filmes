import type { Request } from "express";
import type { DiscordUser, Room } from "../../shared/types";
import type { RoomManager } from "../../core/room-manager";
import {
  ForbiddenHttpError,
  NotFoundHttpError,
  UnauthorizedHttpError,
} from "./http-error";

interface RoomAccessContext {
  room: Room;
  token: string;
  user: DiscordUser;
}

function getTokenFromHeader(request: Request): string {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }

  const roomHeader = request.headers["x-room-token"];
  return typeof roomHeader === "string" ? roomHeader.trim() : "";
}

export function getRoomTokenFromRequest(request: Request, body?: unknown): string {
  const headerToken = getTokenFromHeader(request);
  if (headerToken) return headerToken;

  if (body && typeof body === "object" && !Array.isArray(body)) {
    const bodyToken = (body as Record<string, unknown>).token;
    if (typeof bodyToken === "string" && bodyToken.trim()) {
      return bodyToken.trim();
    }
  }

  return "";
}

function requireDiscordRoom(roomManager: typeof RoomManager.prototype, roomId: string): Room {
  const room = roomManager.getRoom(roomId);
  if (!room || !room.discordSession) {
    throw new NotFoundHttpError("Sessão não encontrada");
  }
  return room;
}

function getRoomAccessFromOAuthSession(
  roomManager: typeof RoomManager.prototype,
  roomId: string,
  room: Room,
  request: Request
): RoomAccessContext | null {
  const discordId = request.oauthSession?.discordId;
  if (!discordId) {
    return null;
  }

  const authorized = roomManager.findAuthorizedUserByDiscordId(roomId, discordId);
  if (!authorized) {
    return null;
  }

  return {
    room,
    token: authorized.token,
    user: authorized.user,
  };
}

export function requireRoomAccess(
  roomManager: typeof RoomManager.prototype,
  roomId: string,
  request: Request,
  body?: unknown
): RoomAccessContext {
  const room = requireDiscordRoom(roomManager, roomId);
  const token = getRoomTokenFromRequest(request, body);

  if (!token) {
    const oauthContext = getRoomAccessFromOAuthSession(roomManager, roomId, room, request);
    if (oauthContext) {
      return oauthContext;
    }

    throw new UnauthorizedHttpError("Token de acesso obrigatório");
  }

  const user = roomManager.validateToken(roomId, token);
  if (!user) {
    throw new ForbiddenHttpError("Token inválido");
  }

  return { room, token, user };
}

export function requireHostRoomAccess(
  roomManager: typeof RoomManager.prototype,
  roomId: string,
  request: Request,
  body?: unknown
): RoomAccessContext {
  const context = requireRoomAccess(roomManager, roomId, request, body);
  if (!context.user.isHost) {
    throw new ForbiddenHttpError("Apenas o host pode executar esta ação");
  }
  return context;
}
