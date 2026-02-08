import client from "./client";
import db from "../database";
import { DISCORD_TOKEN, GEMINI_API_KEY, TMDB_API_KEY } from "../config";
import { registerCommands } from "./commands";
import { registerInteractionHandlers } from "./interactions";
import { buildMovieVoteEmbed } from "./ui/embeds";
import { buildVotingComponents } from "./ui/components";
import { toMovieId } from "./utils";
import { votingCache } from "./state";
import { logger } from "../shared/logger";

import { startSessionMonitor } from "./services/session-monitor";

const restoreActiveVotings = async () => {
  const votacoes = await db.getActiveVotings();
  const entries = Object.entries(votacoes);
  if (!entries.length) {
    return;
  }

  for (const [movieKey, info] of entries) {
    try {
      const channel = await client.channels.fetch(String(info.channel_id));
      if (!channel?.isTextBased()) {
        continue;
      }

      const message = await channel.messages.fetch(String(info.message_id));
      const movieId = toMovieId(movieKey);

      votingCache.set(movieId, {
        movieKey,
        tmdbInfo: info.tmdb_info,
        allowedUsers: info.usuarios_permitidos || [],
      });

      const embed = await buildMovieVoteEmbed(
        movieKey,
        info.tmdb_info,
        info.usuarios_permitidos || [],
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

if (!DISCORD_TOKEN || !GEMINI_API_KEY || !TMDB_API_KEY) {
  throw new Error("Variáveis de ambiente ausentes. Verifique DISCORD_TOKEN, GEMINI_API_KEY e TMDB_API_KEY.");
}

client.login(DISCORD_TOKEN);
