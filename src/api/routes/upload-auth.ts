import type { Request } from "express";
import type { UploadDeps } from "./upload-types";

interface RequestBodyWithAuth {
  token?: unknown;
  hostId?: unknown;
}

function getAuthString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function getAuthFromRequest(request: Request, body?: unknown) {
  const parsedBody =
    body && typeof body === "object" && !Array.isArray(body) ? (body as RequestBodyWithAuth) : undefined;

  const token = getAuthString(parsedBody?.token || request.headers["x-room-token"]);
  const hostId = getAuthString(parsedBody?.hostId || request.headers["x-host-id"]);
  return { token, hostId };
}

export function ensureUploadAuthorized(
  roomId: string,
  token: string,
  hostId: string,
  deps: UploadDeps
): { error: string; status: number } | null {
  const room = deps.roomManager.getRoom(roomId);
  if (!room) {
    return { error: "Sala não encontrada", status: 404 };
  }

  if (room.status === "ended") {
    return { error: "Sessão encerrada", status: 403 };
  }

  if (room.discordSession) {
    if (!token || !deps.roomManager.isHostByToken(roomId, token)) {
      return { error: "Sem permissão para upload", status: 403 };
    }
  } else if (!hostId || room.state.hostId !== hostId) {
    return { error: "Sem permissão para upload", status: 403 };
  }

  return null;
}
