import client from "./client";
import db from "../database";
import { DISCORD_TOKEN, GEMINI_API_KEY, PLAYER_API_SHARED_SECRET, TMDB_API_KEY } from "../config";
import { registerCommands } from "./commands";
import { registerInteractionHandlers } from "./interactions";
import { buildMovieVoteEmbed } from "./ui/embeds";
import { buildVotingComponents } from "./ui/components";
import { toMovieId } from "./utils";
import { votingCache, type TmdbSearchResult } from "./state";
import { logger } from "../shared/logger";
import { startSessionMonitor } from "./services/session-monitor";

interface StoredVoting {
  channel_id: unknown;
  message_id: unknown;
  tmdb_info: TmdbSearchResult | null;
  usuarios_permitidos: string[] | null;
}

const restoreActiveVotings = async () => {
  const votacoes = await db.getActiveVotings();
  const entries = Object.entries(votacoes);
  if (!entries.length) {
    return;
  }

  for (const [movieKey, info] of entries) {
    const stored = info as StoredVoting;
    try {
      const channel = await client.channels.fetch(String(stored.channel_id));
      if (!channel?.isTextBased()) {
        continue;
      }

      const message = await channel.messages.fetch(String(stored.message_id));
      const movieId = toMovieId(movieKey);

      votingCache.set(movieId, {
        movieKey,
        tmdbInfo: stored.tmdb_info,
        allowedUsers: stored.usuarios_permitidos || [],
      });

      const embed = await buildMovieVoteEmbed(
        movieKey,
        stored.tmdb_info,
        stored.usuarios_permitidos || [],
        message.guild
      );
      await message.edit({ embeds: [embed], components: buildVotingComponents(movieId) });
    } catch (error) {
      logger.warn("BotBootstrap", `Falha ao restaurar votação ativa: ${movieKey}`, error);
      await db.removeActiveVoting(movieKey);
    }
  }
};

client.once("clientReady", async () => {
  await db.initDb();
  await db.migrateFromJson();
  await registerCommands(client);
  await restoreActiveVotings();
  startSessionMonitor(client);
  await client.user?.setPresence({ activities: [{ name: "filme dos crias", type: 3 }] });
  logger.success("BotBootstrap", `Bot ${client.user?.tag} conectado`);
  logger.info("BotBootstrap", `Servidores conectados: ${client.guilds.cache.size}`);
});

registerInteractionHandlers(client);

if (!DISCORD_TOKEN || !GEMINI_API_KEY || !TMDB_API_KEY || !PLAYER_API_SHARED_SECRET) {
  throw new Error("Variáveis de ambiente ausentes. Verifique DISCORD_TOKEN, GEMINI_API_KEY, TMDB_API_KEY e PLAYER_API_SHARED_SECRET.");
}

client.login(DISCORD_TOKEN);
