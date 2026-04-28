import type { UploadDeps } from "./upload-types";
import type { Request } from "../http/context";
import { getRoomTokenFromRequest } from "../http/room-access";

export function getAuthFromRequest(request: Request, body?: unknown) {
  return { token: getRoomTokenFromRequest(request, body) };
}

export function ensureUploadAuthorized(
  roomId: string,
  token: string,
  deps: UploadDeps
): { error: string; status: number } | null {
  const room = deps.roomManager.getRoom(roomId);
  if (!room || !room.discordSession) {
    return { error: "Sala não encontrada", status: 404 };
  }

  if (room.status === "ended") {
    return { error: "Sessão encerrada", status: 403 };
  }

  if (!token || !deps.roomManager.isHostByToken(roomId, token)) {
    return { error: "Sem permissão para upload", status: 403 };
  }

  return null;
}
