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

  const queryToken = request.query.token;
  if (typeof queryToken === "string" && queryToken.trim()) {
    return queryToken.trim();
  }

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

export function requireRoomAccess(
  roomManager: typeof RoomManager.prototype,
  roomId: string,
  request: Request,
  body?: unknown
): RoomAccessContext {
  const room = requireDiscordRoom(roomManager, roomId);
  const token = getRoomTokenFromRequest(request, body);

  if (!token) {
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