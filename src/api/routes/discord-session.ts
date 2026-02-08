import { Router } from "express";
import { cleanupRoomUploads } from "./upload";
import type { RoomManager } from "../../core/room-manager";

interface DiscordSessionDeps {
  roomManager: typeof RoomManager.prototype; // Assuming singleton or class instance
  getSessionStatusData: (roomId: string) => any;
  uploadsDir: string;
}

export function createDiscordSessionRouter(deps: DiscordSessionDeps): Router {
  const router = Router();

  router.post("/discord-session", async (req, res) => {
    if (deps.roomManager.hasAnyRooms()) {
      res.status(409).json({ error: "Já existe uma sessão ativa" });
      return;
    }

    if (deps.roomManager.hasActiveDiscordSession()) {
      console.log("[DiscordSession] Tentativa de criar sessão com outra ativa");
      res.status(409).json({ error: "Já existe uma sessão ativa" });
      return;
    }

    const { title, movieName, movieInfo, discordSession, selectedEpisode } = req.body;

    if (!discordSession?.hostDiscordId || !discordSession?.channelId || !discordSession?.guildId) {
      res.status(400).json({ error: "Dados do Discord incompletos" });
      return;
    }

    const result = deps.roomManager.createDiscordSession(
      title || "Sessão de Cinema",
      movieName || "Filme",
      movieInfo,
      discordSession,
      selectedEpisode
    );

    if (!result) {
      console.log("[DiscordSession] Falha ao criar sessão");
      res.status(500).json({ error: "Erro ao criar sessão" });
      return;
    }

    console.log(`[DiscordSession] Sessão criada: room=${result.roomId} host=${discordSession.hostDiscordId}`);

    res.json({
      roomId: result.roomId,
      hostToken: result.hostToken,
      url: `/room/${result.roomId}?token=${result.hostToken}`
    });
  });

  router.post("/session-token/:roomId", async (req, res) => {
    const { roomId } = req.params;
    const room = deps.roomManager.getRoom(roomId);

    if (!room || !room.discordSession) {
      res.status(404).json({ error: "Sessão não encontrada" });
      return;
    }

    const { discordId, username } = req.body;

    if (!discordId || !username) {
      res.status(400).json({ error: "Dados do usuário incompletos" });
      return;
    }

    const token = deps.roomManager.generateUserToken(roomId, discordId, username);
    if (!token) {
      res.status(500).json({ error: "Erro ao gerar token" });
      return;
    }

    res.json({
      token,
      url: `/room/${roomId}?token=${token}`
    });
  });

  router.get("/validate-token/:roomId", (req, res) => {
    const { roomId } = req.params;
    const token = req.query.token as string;

    if (!token) {
      res.status(400).json({ error: "Token não fornecido" });
      return;
    }

    const user = deps.roomManager.validateToken(roomId, token);
    if (!user) {
      console.log(`[DiscordSession] Token inválido: room=${roomId}`);
      res.status(403).json({ error: "Token inválido" });
      return;
    }

    res.json({
      discordId: user.discordId,
      username: user.username,
      isHost: user.isHost
    });
  });

  router.get("/session-status/:roomId", (req, res) => {
    const { roomId } = req.params;
    const data = deps.getSessionStatusData(roomId);

    if (!data) {
      res.status(404).json({ error: "Sessão não encontrada" });
      return;
    }

    res.json(data);
  });

  router.post("/session-rating/:roomId", async (req, res) => {
    const { roomId } = req.params;
    const room = deps.roomManager.getRoom(roomId);

    if (!room) {
      res.status(404).json({ error: "Sessão não encontrada" });
      return;
    }

    const { token, rating } = req.body;

    if (!token || typeof rating !== "number" || rating < 1 || rating > 10) {
      res.status(400).json({ error: "Dados inválidos" });
      return;
    }

    const user = deps.roomManager.validateToken(roomId, token);
    if (!user) {
      console.log(`[DiscordSession] Nota rejeitada por token inválido: room=${roomId}`);
      res.status(403).json({ error: "Token inválido" });
      return;
    }

    deps.roomManager.addRating(roomId, user.discordId, user.username, rating);
    console.log(`[DiscordSession] Nota recebida: room=${roomId} discordId=${user.discordId} rating=${rating}`);

    deps.roomManager.broadcastAll(roomId, {
      type: "rating-received",
      ratings: deps.roomManager.getRatings(roomId).ratings
    });

    const allRated = deps.roomManager.allUsersRated(roomId);
    if (allRated) {
      const { ratings: allRatings, average } = deps.roomManager.getRatings(roomId);
      console.log(`[DiscordSession] Todas as notas recebidas: room=${roomId} média=${average}`);
      deps.roomManager.broadcastAll(roomId, {
        type: "all-ratings-received",
        ratings: allRatings,
        average
      });
    }

    res.json({
      success: true,
      allRated,
      ...deps.roomManager.getRatings(roomId)
    });
  });

  router.post("/discord-end-session/:roomId", async (req, res) => {
    const { roomId } = req.params;
    const room = deps.roomManager.getRoom(roomId);

    if (!room) {
      res.status(404).json({ error: "Sessão não encontrada" });
      return;
    }

    const { token } = req.body;

    if (!deps.roomManager.isHostByToken(roomId, token)) {
      console.log(`[DiscordSession] Encerramento negado (não host): room=${roomId}`);
      res.status(403).json({ error: "Apenas o host pode encerrar" });
      return;
    }

    deps.roomManager.setSessionStatus(roomId, "ended");
    console.log(`[DiscordSession] Encerramento solicitado: room=${roomId}`);
    deps.roomManager.broadcastAll(roomId, { type: "session-ending" });

    const statusData = deps.getSessionStatusData(roomId);
    if (statusData) {
      deps.roomManager.broadcastAll(roomId, { type: "session-status", ...statusData });
    }

    res.json({ success: true, status: "ending" });
  });

  router.post("/discord-finalize-session/:roomId", async (req, res) => {
    const { roomId } = req.params;
    const room = deps.roomManager.getRoom(roomId);

    if (!room) {
      res.status(404).json({ error: "Sessão não encontrada" });
      return;
    }

    const { token } = req.body || {};
    if (!token || !deps.roomManager.isHostByToken(roomId, token)) {
      console.log(`[DiscordSession] Finalização negada (não host): room=${roomId}`);
      res.status(403).json({ error: "Apenas o host pode finalizar" });
      return;
    }

    const { ratings, average } = deps.roomManager.getRatings(roomId);
    const discordSession = room.discordSession;

    console.log(`[DiscordSession] Finalizando sessão: room=${roomId} média=${average}`);

    deps.roomManager.broadcastAll(roomId, { type: "session-ended" });
    try {
      await cleanupRoomUploads(deps.uploadsDir, roomId);
      await deps.roomManager.deleteRoom(roomId);
    } catch (error) {
      console.error(`[DiscordSession] Falha ao finalizar recursos da sala ${roomId}:`, error);
    }

    res.json({
      success: true,
      ratings,
      average,
      discordSession
    });
  });

  return router;
}
