import { Router } from "express";
import { cleanupRoomUploads } from "./upload";
import type { RoomManager } from "../../core/room-manager";
import { logger } from "../../shared/logger";
import { sendRouteError } from "../http/route-error";
import {
  ConflictHttpError,
  ForbiddenHttpError,
  InfraHttpError,
  NotFoundHttpError,
} from "../http/http-error";
import { optionalString, requireNonEmptyString, requireNumberInRange, requireObject } from "../http/validation";

interface DiscordSessionDeps {
  roomManager: typeof RoomManager.prototype;
  getSessionStatusData: (roomId: string) => Record<string, unknown> | null;
  uploadsDir: string;
}

interface DiscordSessionInput {
  channelId: string;
  messageId: string;
  guildId: string;
  hostDiscordId: string;
  hostUsername?: string;
}

interface CreateDiscordSessionPayload {
  title: string;
  movieName: string;
  movieInfo?: unknown;
  selectedEpisode?: unknown;
  discordSession: DiscordSessionInput;
}

interface SessionTokenPayload {
  discordId: string;
  username: string;
}

interface SessionRatingPayload {
  token: string;
  rating: number;
}

interface HostTokenPayload {
  token: string;
}

function parseDiscordSessionInput(raw: unknown): DiscordSessionInput {
  const sessionObject = requireObject(raw, "discordSession");

  return {
    hostDiscordId: requireNonEmptyString(sessionObject.hostDiscordId, "discordSession.hostDiscordId"),
    channelId: requireNonEmptyString(sessionObject.channelId, "discordSession.channelId"),
    messageId: requireNonEmptyString(sessionObject.messageId, "discordSession.messageId"),
    guildId: requireNonEmptyString(sessionObject.guildId, "discordSession.guildId"),
    hostUsername: optionalString(sessionObject.hostUsername),
  };
}

function parseCreateDiscordSessionPayload(raw: unknown): CreateDiscordSessionPayload {
  const payload = requireObject(raw);

  return {
    title: optionalString(payload.title) || "Sessão de Cinema",
    movieName: optionalString(payload.movieName) || "Filme",
    movieInfo: payload.movieInfo,
    selectedEpisode: payload.selectedEpisode,
    discordSession: parseDiscordSessionInput(payload.discordSession),
  };
}

function parseSessionTokenPayload(raw: unknown): SessionTokenPayload {
  const payload = requireObject(raw);
  return {
    discordId: requireNonEmptyString(payload.discordId, "discordId"),
    username: requireNonEmptyString(payload.username, "username"),
  };
}

function parseSessionRatingPayload(raw: unknown): SessionRatingPayload {
  const payload = requireObject(raw);
  return {
    token: requireNonEmptyString(payload.token, "token"),
    rating: requireNumberInRange(payload.rating, "rating", 1, 10),
  };
}

function parseHostTokenPayload(raw: unknown): HostTokenPayload {
  const payload = requireObject(raw);
  return {
    token: requireNonEmptyString(payload.token, "token"),
  };
}

function parseTokenFromQuery(raw: unknown): string {
  if (Array.isArray(raw)) {
    return requireNonEmptyString(raw[0], "token");
  }
  return requireNonEmptyString(raw, "token");
}

function ensureSessionRoom(deps: DiscordSessionDeps, roomId: string) {
  const room = deps.roomManager.getRoom(roomId);
  if (!room || !room.discordSession) {
    throw new NotFoundHttpError("Sessão não encontrada");
  }
  return room;
}

function ensureHostToken(deps: DiscordSessionDeps, roomId: string, token: string): void {
  if (!deps.roomManager.isHostByToken(roomId, token)) {
    throw new ForbiddenHttpError("Apenas o host pode executar esta ação");
  }
}

export function createDiscordSessionRouter(deps: DiscordSessionDeps): Router {
  const router = Router();

  router.post("/discord-session", async (req, res) => {
    try {
      if (deps.roomManager.hasAnyRooms() || deps.roomManager.hasActiveDiscordSession()) {
        throw new ConflictHttpError("Já existe uma sessão ativa");
      }

      const payload = parseCreateDiscordSessionPayload(req.body);
      const result = deps.roomManager.createDiscordSession(
        payload.title,
        payload.movieName,
        payload.movieInfo as any,
        payload.discordSession,
        payload.selectedEpisode
      );

      if (!result) {
        throw new InfraHttpError("Erro ao criar sessão");
      }

      logger.info(
        "DiscordSession",
        `Sessão criada: room=${result.roomId} host=${payload.discordSession.hostDiscordId}`
      );

      res.json({
        roomId: result.roomId,
        hostToken: result.hostToken,
        url: `/room/${result.roomId}?token=${result.hostToken}`,
      });
    } catch (error) {
      sendRouteError(res, error, "DiscordSession");
    }
  });

  router.post("/session-token/:roomId", async (req, res) => {
    try {
      const { roomId } = req.params;
      ensureSessionRoom(deps, roomId);

      const payload = parseSessionTokenPayload(req.body);
      const token = deps.roomManager.generateUserToken(roomId, payload.discordId, payload.username);
      if (!token) {
        throw new InfraHttpError("Erro ao gerar token");
      }

      res.json({
        token,
        url: `/room/${roomId}?token=${token}`,
      });
    } catch (error) {
      sendRouteError(res, error, "DiscordSession");
    }
  });

  router.get("/validate-token/:roomId", (req, res) => {
    try {
      const { roomId } = req.params;
      const token = parseTokenFromQuery(req.query.token);

      const user = deps.roomManager.validateToken(roomId, token);
      if (!user) {
        throw new ForbiddenHttpError("Token inválido");
      }

      res.json({
        discordId: user.discordId,
        username: user.username,
        isHost: user.isHost,
      });
    } catch (error) {
      sendRouteError(res, error, "DiscordSession");
    }
  });

  router.get("/session-status/:roomId", (req, res) => {
    try {
      const { roomId } = req.params;
      const data = deps.getSessionStatusData(roomId);
      if (!data) {
        throw new NotFoundHttpError("Sessão não encontrada");
      }
      res.json(data);
    } catch (error) {
      sendRouteError(res, error, "DiscordSession");
    }
  });

  router.post("/session-rating/:roomId", async (req, res) => {
    try {
      const { roomId } = req.params;
      ensureSessionRoom(deps, roomId);

      const payload = parseSessionRatingPayload(req.body);
      const user = deps.roomManager.validateToken(roomId, payload.token);
      if (!user) {
        throw new ForbiddenHttpError("Token inválido");
      }

      deps.roomManager.addRating(roomId, user.discordId, user.username, payload.rating);
      logger.info(
        "DiscordSession",
        `Nota recebida: room=${roomId} discordId=${user.discordId} rating=${payload.rating}`
      );

      deps.roomManager.broadcastAll(roomId, {
        type: "rating-received",
        ratings: deps.roomManager.getRatings(roomId).ratings,
      });

      const allRated = deps.roomManager.allUsersRated(roomId);
      if (allRated) {
        const { ratings: allRatings, average } = deps.roomManager.getRatings(roomId);
        logger.info("DiscordSession", `Todas as notas recebidas: room=${roomId} media=${average}`);
        deps.roomManager.broadcastAll(roomId, {
          type: "all-ratings-received",
          ratings: allRatings,
          average,
        });
      }

      res.json({
        success: true,
        allRated,
        ...deps.roomManager.getRatings(roomId),
      });
    } catch (error) {
      sendRouteError(res, error, "DiscordSession");
    }
  });

  router.post("/discord-end-session/:roomId", async (req, res) => {
    try {
      const { roomId } = req.params;
      ensureSessionRoom(deps, roomId);

      const payload = parseHostTokenPayload(req.body);
      ensureHostToken(deps, roomId, payload.token);

      deps.roomManager.setSessionStatus(roomId, "ended");
      logger.info("DiscordSession", `Encerramento solicitado: room=${roomId}`);
      deps.roomManager.broadcastAll(roomId, { type: "session-ending" });

      const statusData = deps.getSessionStatusData(roomId);
      if (statusData) {
        deps.roomManager.broadcastAll(roomId, { type: "session-status", ...statusData });
      }

      res.json({ success: true, status: "ending" });
    } catch (error) {
      sendRouteError(res, error, "DiscordSession");
    }
  });

  router.post("/discord-finalize-session/:roomId", async (req, res) => {
    try {
      const { roomId } = req.params;
      const room = ensureSessionRoom(deps, roomId);

      const payload = parseHostTokenPayload(req.body);
      ensureHostToken(deps, roomId, payload.token);

      const { ratings, average } = deps.roomManager.getRatings(roomId);
      logger.info("DiscordSession", `Finalizando sessão: room=${roomId} media=${average}`);

      deps.roomManager.broadcastAll(roomId, { type: "session-ended" });
      await cleanupRoomUploads(deps.uploadsDir, roomId);
      await deps.roomManager.deleteRoom(roomId);

      res.json({
        success: true,
        ratings,
        average,
        discordSession: room.discordSession,
      });
    } catch (error) {
      sendRouteError(res, error, "DiscordSession");
    }
  });

  return router;
}
