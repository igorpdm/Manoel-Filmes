import { Router } from "../http/context";
import { cleanupRoomUploads } from "./upload";
import type { RoomManager } from "../../core/room-manager";
import type {
  DiscordSession,
  MovieInfo,
  RatingProgress,
  RatingRoundCompletionReason,
  RatingRoundScope,
  SelectedEpisode,
} from "../../shared/types";
import type { SessionStatusData } from "../services/session-status";
import { logger } from "../../shared/logger";
import { sendRouteError } from "../http/route-error";
import { requireRoomAccess } from "../http/room-access";
import { createRateLimit } from "../http/rate-limit";
import { requireTrustedService } from "../http/service-auth";
import {
  ConflictHttpError,
  ForbiddenHttpError,
  InfraHttpError,
  NotFoundHttpError,
} from "../http/http-error";
import { optionalString, requireNonEmptyString, requireNumberInRange, requireObject } from "../http/validation";

interface DiscordSessionDeps {
  roomManager: typeof RoomManager.prototype;
  getSessionStatusData: (roomId: string) => SessionStatusData | null;
  uploadsDir: string;
}

const createSessionRateLimit = createRateLimit({ key: "discord-session-create", limit: 15, windowMs: 60000 });
const issueTokenRateLimit = createRateLimit({ key: "discord-session-token", limit: 30, windowMs: 60000 });
const validateTokenRateLimit = createRateLimit({ key: "discord-session-validate", limit: 60, windowMs: 60000 });
const RATING_TIMEOUT_MS = 2 * 60 * 1000;

const ratingTimeouts = new Map<string, NodeJS.Timeout>();

interface CreateDiscordSessionPayload {
  movieName: string;
  movieInfo?: MovieInfo;
  selectedEpisode?: SelectedEpisode;
  discordSession: DiscordSession & { hostUsername?: string };
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

function parseDiscordSessionInput(raw: unknown): DiscordSession & { hostUsername?: string } {
  const sessionObject = requireObject(raw, "discordSession");

  return {
    hostDiscordId: requireNonEmptyString(sessionObject.hostDiscordId, "discordSession.hostDiscordId"),
    channelId: requireNonEmptyString(sessionObject.channelId, "discordSession.channelId"),
    messageId: requireNonEmptyString(sessionObject.messageId, "discordSession.messageId"),
    guildId: requireNonEmptyString(sessionObject.guildId, "discordSession.guildId"),
    hostUsername: optionalString(sessionObject.hostUsername),
  };
}

function parseSelectedEpisode(value: unknown): SelectedEpisode | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const parsed = value as Record<string, unknown>;
  const seasonNumber = Number(parsed.seasonNumber);
  const episodeNumber = Number(parsed.episodeNumber);
  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";

  if (!Number.isFinite(seasonNumber) || !Number.isFinite(episodeNumber) || !name) {
    return undefined;
  }

  return {
    id: typeof parsed.id === "number" ? parsed.id : undefined,
    seasonNumber,
    episodeNumber,
    name,
    overview: typeof parsed.overview === "string" ? parsed.overview : undefined,
    stillPath: typeof parsed.stillPath === "string" || parsed.stillPath === null ? parsed.stillPath : undefined,
    airDate: typeof parsed.airDate === "string" ? parsed.airDate : undefined,
    runtime: typeof parsed.runtime === "number" ? parsed.runtime : undefined,
  };
}

function parseCreateDiscordSessionPayload(raw: unknown): CreateDiscordSessionPayload {
  const payload = requireObject(raw);

  return {
    movieName: optionalString(payload.movieName) || "Filme",
    movieInfo: payload.movieInfo && typeof payload.movieInfo === "object" ? (payload.movieInfo as MovieInfo) : undefined,
    selectedEpisode: parseSelectedEpisode(payload.selectedEpisode),
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

function parseRoomIdParam(raw: unknown): string {
  if (Array.isArray(raw)) {
    return requireNonEmptyString(raw[0], "roomId");
  }

  return requireNonEmptyString(raw, "roomId");
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

function clearRatingTimeout(roomId: string): void {
  const timeout = ratingTimeouts.get(roomId);
  if (!timeout) return;

  clearTimeout(timeout);
  ratingTimeouts.delete(roomId);
}

function broadcastRatingProgress(deps: DiscordSessionDeps, roomId: string, ratingProgress: RatingProgress): void {
  deps.roomManager.broadcastAll(roomId, {
    type: "rating-progress",
    ratingProgress,
  });
}

function finishRatingRound(
  deps: DiscordSessionDeps,
  roomId: string,
  completionReason: RatingRoundCompletionReason
): RatingProgress | null {
  clearRatingTimeout(roomId);

  const ratingProgress = deps.roomManager.finishRatingRound(roomId, completionReason);
  if (!ratingProgress) {
    return null;
  }

  broadcastRatingProgress(deps, roomId, ratingProgress);
  deps.roomManager.broadcastAll(roomId, {
    type: "all-ratings-received",
    ratings: ratingProgress.ratings,
    average: ratingProgress.average,
    allRated: true,
    completionReason,
    ratingProgress,
  });

  return ratingProgress;
}

function scheduleRatingTimeout(
  deps: DiscordSessionDeps,
  roomId: string,
  scope: RatingRoundScope
): void {
  clearRatingTimeout(roomId);

  const timeout = setTimeout(() => {
    ratingTimeouts.delete(roomId);

    const ratingProgress = deps.roomManager.getRatingProgress(roomId);
    if (!ratingProgress || ratingProgress.isClosed) {
      return;
    }

    logger.info(
      "DiscordSession",
      `Timeout de votação atingido: room=${roomId} scope=${scope} votos=${ratingProgress.ratings.length}/${ratingProgress.participants.length}`
    );
    finishRatingRound(deps, roomId, "timeout");
  }, RATING_TIMEOUT_MS);

  ratingTimeouts.set(roomId, timeout);
}

function startRatingRound(
  deps: DiscordSessionDeps,
  roomId: string,
  scope: RatingRoundScope
): RatingProgress | null {
  const currentRatingProgress = deps.roomManager.getRatingProgress(roomId);
  if (currentRatingProgress) {
    return currentRatingProgress;
  }

  const ratingProgress = deps.roomManager.startRatingRound(roomId, scope, RATING_TIMEOUT_MS);
  if (!ratingProgress) {
    return null;
  }

  if (ratingProgress.participants.length === 0) {
    return finishRatingRound(deps, roomId, "all_rated");
  }

  scheduleRatingTimeout(deps, roomId, scope);
  return ratingProgress;
}

/**
 * Cria rotas HTTP para ciclo de vida de sessões ligadas ao Discord.
 * @param deps Dependências de estado de sala e funções auxiliares de sessão.
 * @returns Instância de router com endpoints de sessão.
 * @throws Retorna erros HTTP de validação, permissão, conflito e infraestrutura.
 */
export function createDiscordSessionRouter(deps: DiscordSessionDeps): Router {
  const router = Router();

  router.post("/discord-session", createSessionRateLimit, async (req, res) => {
    try {
      requireTrustedService(req);

      if (deps.roomManager.hasAnyRooms() || deps.roomManager.hasActiveDiscordSession()) {
        throw new ConflictHttpError("Já existe uma sessão ativa");
      }

      const payload = parseCreateDiscordSessionPayload(req.body);
      const result = deps.roomManager.createDiscordSession(
        payload.movieName,
        payload.movieInfo,
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
        url: `/room/${result.roomId}`,
      });
    } catch (error) {
      sendRouteError(res, error, "DiscordSession");
    }
  });

  router.post("/session-token/:roomId", issueTokenRateLimit, async (req, res) => {
    try {
      requireTrustedService(req);

      const roomId = parseRoomIdParam(req.params.roomId);
      ensureSessionRoom(deps, roomId);

      const payload = parseSessionTokenPayload(req.body);
      const token = deps.roomManager.generateUserToken(roomId, payload.discordId, payload.username);
      if (!token) {
        throw new InfraHttpError("Erro ao gerar token");
      }

      res.json({
        token,
        url: `/room/${roomId}`,
      });
    } catch (error) {
      sendRouteError(res, error, "DiscordSession");
    }
  });

  router.get("/validate-token/:roomId", validateTokenRateLimit, (req, res) => {
    try {
      const roomId = parseRoomIdParam(req.params.roomId);
      const { user } = requireRoomAccess(deps.roomManager, roomId, req);

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
      const roomId = parseRoomIdParam(req.params.roomId);
      requireRoomAccess(deps.roomManager, roomId, req);
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
      const roomId = parseRoomIdParam(req.params.roomId);
      ensureSessionRoom(deps, roomId);

      const currentRatingProgress = deps.roomManager.getRatingProgress(roomId);
      if (!currentRatingProgress || currentRatingProgress.isClosed) {
        throw new ConflictHttpError("A votação não está ativa");
      }

      const payload = parseSessionRatingPayload(req.body);
      const user = deps.roomManager.validateToken(roomId, payload.token);
      if (!user) {
        throw new ForbiddenHttpError("Token inválido");
      }

      if (!deps.roomManager.isRatingRoundParticipant(roomId, user.discordId)) {
        throw new ForbiddenHttpError("Você não faz parte desta votação");
      }

      const didRegisterRating = deps.roomManager.addRating(roomId, user.discordId, user.username, payload.rating);
      if (!didRegisterRating) {
        throw new ConflictHttpError("Não foi possível registrar a nota");
      }

      logger.info(
        "DiscordSession",
        `Nota recebida: room=${roomId} discordId=${user.discordId} rating=${payload.rating}`
      );

      const allRated = deps.roomManager.allUsersRated(roomId);
      let ratingProgress = deps.roomManager.getRatingProgress(roomId);

      if (allRated) {
        logger.info("DiscordSession", `Rodada de notas concluída: room=${roomId}`);
        ratingProgress = finishRatingRound(deps, roomId, "all_rated");
      } else if (ratingProgress) {
        broadcastRatingProgress(deps, roomId, ratingProgress);
      }

      const responseProgress = ratingProgress ?? deps.roomManager.getRatingProgress(roomId);

      res.json({
        success: true,
        allRated,
        ratings: responseProgress?.ratings ?? [],
        average: responseProgress?.average ?? 0,
        ratingProgress: responseProgress,
      });
    } catch (error) {
      sendRouteError(res, error, "DiscordSession");
    }
  });

  router.post("/discord-end-session/:roomId", async (req, res) => {
    try {
      const roomId = parseRoomIdParam(req.params.roomId);
      ensureSessionRoom(deps, roomId);

      const payload = parseHostTokenPayload(req.body);
      ensureHostToken(deps, roomId, payload.token);

      deps.roomManager.setSessionStatus(roomId, "ended");
      const ratingProgress = startRatingRound(deps, roomId, "session");

      logger.info("DiscordSession", `Encerramento solicitado: room=${roomId}`);
      deps.roomManager.broadcastAll(roomId, { type: "session-ending" });

      if (ratingProgress && !ratingProgress.isClosed) {
        broadcastRatingProgress(deps, roomId, ratingProgress);
      }

      const statusData = deps.getSessionStatusData(roomId);
      if (statusData) {
        deps.roomManager.broadcastAll(roomId, { type: "session-status", ...statusData });
      }

      res.json({ success: true, status: "ending", ratingProgress });
    } catch (error) {
      sendRouteError(res, error, "DiscordSession");
    }
  });

  router.post("/discord-finalize-session/:roomId", async (req, res) => {
    try {
      const roomId = parseRoomIdParam(req.params.roomId);
      const room = ensureSessionRoom(deps, roomId);

      const payload = parseHostTokenPayload(req.body);
      ensureHostToken(deps, roomId, payload.token);

      const { ratings, average } = deps.roomManager.getRatings(roomId);
      logger.info("DiscordSession", `Finalizando sessão: room=${roomId} media=${average}`);

      clearRatingTimeout(roomId);
      deps.roomManager.clearRatingRound(roomId);
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

  router.post("/discord-cancel-session/:roomId", async (req, res) => {
    try {
      const roomId = parseRoomIdParam(req.params.roomId);
      ensureSessionRoom(deps, roomId);

      const payload = parseHostTokenPayload(req.body);
      ensureHostToken(deps, roomId, payload.token);

      logger.info("DiscordSession", `Cancelamento solicitado: room=${roomId}`);
      clearRatingTimeout(roomId);
      deps.roomManager.clearRatingRound(roomId);
      deps.roomManager.broadcastAll(roomId, { type: "session-cancelled" });
      await cleanupRoomUploads(deps.uploadsDir, roomId);
      await deps.roomManager.deleteRoom(roomId);

      res.json({ success: true });
    } catch (error) {
      sendRouteError(res, error, "DiscordSession");
    }
  });

  router.post("/next-episode/:roomId", async (req, res) => {
    try {
      const roomId = parseRoomIdParam(req.params.roomId);
      ensureSessionRoom(deps, roomId);

      const payload = parseHostTokenPayload(req.body);
      ensureHostToken(deps, roomId, payload.token);

      const room = deps.roomManager.getRoom(roomId)!;
      if (!room.movieInfo || room.movieInfo.mediaType !== "tv") {
        res.status(400).json({ error: "Recurso disponível apenas para séries" });
        return;
      }

      logger.info("DiscordSession", `Dados de episódios solicitados: room=${roomId}`);

      const nextEpisode = deps.roomManager.getNextEpisode(roomId);

      res.json({
        success: true,
        currentEpisode: room.selectedEpisode || null,
        nextEpisode,
        seasons: room.movieInfo.seasons || [],
      });
    } catch (error) {
      sendRouteError(res, error, "DiscordSession");
    }
  });

  router.post("/next-episode-proceed/:roomId", async (req, res) => {
    try {
      const roomId = parseRoomIdParam(req.params.roomId);
      const room = ensureSessionRoom(deps, roomId);

      const payload = requireObject(req.body);
      const token = requireNonEmptyString(payload.token, "token");
      ensureHostToken(deps, roomId, token);

      const selectedEpisode = parseSelectedEpisode(payload.selectedEpisode);
      if (!selectedEpisode) {
        res.status(400).json({ error: "Episódio inválido" });
        return;
      }

      room.pendingNextEpisode = selectedEpisode;
      const ratingProgress = startRatingRound(deps, roomId, "episode");

      logger.info("DiscordSession", `Avaliação de episódio iniciada: room=${roomId}, próximo=T${selectedEpisode.seasonNumber}E${selectedEpisode.episodeNumber}`);

      deps.roomManager.broadcastAll(roomId, { type: "episode-ending" });

      if (ratingProgress && !ratingProgress.isClosed) {
        broadcastRatingProgress(deps, roomId, ratingProgress);
      }

      res.json({ success: true, ratingProgress });
    } catch (error) {
      sendRouteError(res, error, "DiscordSession");
    }
  });

  router.post("/next-episode-finalize/:roomId", async (req, res) => {
    try {
      const roomId = parseRoomIdParam(req.params.roomId);
      const room = ensureSessionRoom(deps, roomId);

      const payload = parseHostTokenPayload(req.body);
      ensureHostToken(deps, roomId, payload.token);

      const selectedEpisode = room.pendingNextEpisode;
      if (!selectedEpisode) {
        res.status(400).json({ error: "Nenhum episódio pendente" });
        return;
      }

      clearRatingTimeout(roomId);
      deps.roomManager.clearRatingRound(roomId);
      deps.roomManager.saveCurrentEpisodeToHistory(roomId);
      await cleanupRoomUploads(deps.uploadsDir, roomId);
      await deps.roomManager.resetForNextEpisode(roomId);

      const displayTitle = `${room.movieInfo?.title || ""} - T${selectedEpisode.seasonNumber}E${selectedEpisode.episodeNumber}`;
      deps.roomManager.updateEpisodeInfo(roomId, selectedEpisode, displayTitle);
      room.pendingNextEpisode = undefined;

      logger.info("DiscordSession", `Próximo episódio: room=${roomId} → ${displayTitle}`);

      deps.roomManager.broadcastAll(roomId, {
        type: "next-episode",
        selectedEpisode,
        movieName: displayTitle,
        episodeHistory: deps.roomManager.getEpisodeHistory(roomId),
      });

      const statusData = deps.getSessionStatusData(roomId);
      if (statusData) {
        deps.roomManager.broadcastAll(roomId, { type: "session-status", ...statusData });
      }

      res.json({
        success: true,
        movieName: displayTitle,
        selectedEpisode,
        episodeHistory: deps.roomManager.getEpisodeHistory(roomId),
      });
    } catch (error) {
      sendRouteError(res, error, "DiscordSession");
    }
  });

  return router;
}
