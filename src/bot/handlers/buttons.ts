import {
  GuildMember,
  MessageFlags,
  ButtonInteraction,
  TextChannel,
  NewsChannel,
} from "discord.js";
import type { SelectedEpisode } from "../../shared/types";
import db from "../../database";
import * as playerApi from "../services/player-api";
import {
  buildVotingComponents,
  buildListComponents,
  buildWatchlistComponents,
  buildSessionComponents,
} from "../ui/components";
import {
  buildMovieVoteEmbed,
  buildListEmbed,
  buildWatchlistEmbed,
  buildSessionEmbed,
} from "../ui/embeds";
import { toMovieId } from "../utils";
import {
  votingCache,
  listCache,
  watchlistCache,
  pendingRegisterCache,
  pendingWatchlistCache,
  pendingSessionCache,
  activeWatchSession,
  setActiveWatchSession,
  recCache,
} from "../state";

export const handleButton = async (interaction: ButtonInteraction) => {
  const { customId } = interaction;

  if (customId === "register_confirm" || customId === "register_cancel") {
    const pending = pendingRegisterCache.get(interaction.message.id);
    if (!pending) {
      await interaction.reply({ content: "❌ Esta confirmação expirou.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (customId === "register_cancel") {
      pendingRegisterCache.delete(interaction.message.id);
      await interaction.update({ content: "❌ Registro cancelado.", embeds: [], components: [] });
      return;
    }

    const movieKey = pending.tmdbInfo?.title || pending.filmeBusca;
    await db.registerMovieStart(movieKey, pending.tmdbInfo as unknown as Record<string, unknown>);

    const movieId = toMovieId(movieKey);
    votingCache.set(movieId, {
      movieKey,
      tmdbInfo: pending.tmdbInfo,
      allowedUsers: pending.usuariosIds,
    });

    const embed = await buildMovieVoteEmbed(movieKey, pending.tmdbInfo, pending.usuariosIds, interaction.guild);
    embed.addFields({ name: "👥 Espectadores", value: pending.usuariosNomes.join(" • "), inline: false });

    await interaction.update({
      content: "🎬 **Votação criada!** Clique em um número para registrar sua nota:",
      embeds: [embed],
      components: buildVotingComponents(movieId),
    });

    const message = await interaction.fetchReply();
    await db.saveActiveVoting(movieKey, message.id, interaction.channelId, pending.tmdbInfo as unknown as Record<string, unknown>, pending.usuariosIds);
    pendingRegisterCache.delete(interaction.message.id);
    return;
  }

  if (customId === "watch_add_confirm" || customId === "watch_add_cancel") {
    const pending = pendingWatchlistCache.get(interaction.message.id);
    if (!pending) {
      await interaction.reply({ content: "❌ Esta confirmação expirou.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (customId === "watch_add_cancel") {
      pendingWatchlistCache.delete(interaction.message.id);
      await interaction.update({ content: "❌ Cancelado.", embeds: [], components: [] });
      return;
    }

    const success = await db.addToWatchlist(
      pending.tmdbInfo.title,
      pending.tmdbInfo as unknown as Record<string, unknown>,
      pending.userId,
      pending.userName,
      pending.reason
    );

    if (success) {
      await interaction.update({
        content: `✅ **${pending.tmdbInfo.title}** adicionado à watchlist com sucesso!`,
        embeds: [],
        components: [],
      });
    } else {
      await interaction.update({
        content: `⚠️ **${pending.tmdbInfo.title}** já está na watchlist!`,
        embeds: [],
        components: [],
      });
    }

    pendingWatchlistCache.delete(interaction.message.id);
    return;
  }

  if (customId.startsWith("vote:")) {
    const [, movieId, scoreRaw] = customId.split(":");
    const cached = votingCache.get(movieId);
    if (!cached) {
      await interaction.reply({ content: "❌ Esta votação não está mais ativa.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (!cached.allowedUsers.includes(interaction.user.id)) {
      await interaction.reply({ content: "❌ Você não está na lista de espectadores deste filme!", flags: MessageFlags.Ephemeral });
      return;
    }

    const score = Number(scoreRaw);
    await db.addVote(cached.movieKey, interaction.user.id, interaction.member instanceof GuildMember ? interaction.member.displayName : interaction.user.username, score);

    const ratings = await db.getMovieRatings(cached.movieKey);
    const scores = ratings.map((rating) => rating.score);
    const media = scores.reduce((acc, value) => acc + value, 0) / scores.length;
    const totalVotos = ratings.length;
    const totalPermitidos = cached.allowedUsers.length;

    await interaction.reply({
      content: `✅ **Nota Registrada!**\n🎬 **${cached.movieKey}**\n⭐ Sua nota: **${score}/10**\n📊 Média atual: **${media.toFixed(
        1
      )}/10** (${totalVotos}/${totalPermitidos} votos)`,
      flags: MessageFlags.Ephemeral,
    });

    const embed = await buildMovieVoteEmbed(cached.movieKey, cached.tmdbInfo, cached.allowedUsers, interaction.guild);
    await interaction.message.edit({ embeds: [embed], components: buildVotingComponents(movieId) });

    if (totalVotos >= totalPermitidos) {
      await db.removeActiveVoting(cached.movieKey);
    }
    return;
  }

  if (customId.startsWith("remind:")) {
    const [, movieId] = customId.split(":");
    const cached = votingCache.get(movieId);
    if (!cached) {
      await interaction.reply({ content: "❌ Esta votação não está mais ativa.", flags: MessageFlags.Ephemeral });
      return;
    }

    const ratings = await db.getMovieRatings(cached.movieKey);
    const usuariosVotaram = new Set(ratings.map((rating) => String(rating.user_id)));
    const usuariosFaltam = cached.allowedUsers.filter((uid: string) => !usuariosVotaram.has(uid));

    if (!usuariosFaltam.length) {
      await interaction.reply({ content: "✅ **Todos já votaram!** A votação está completa.", flags: MessageFlags.Ephemeral });
      return;
    }

    const mencoes = usuariosFaltam.map((uid: string) => `<@${uid}>`).join(" ");
    await interaction.reply({
      content:
        `⏳ **Faltam ${usuariosFaltam.length} voto(s)!**\n\n` +
        `📢 ${mencoes}\n\n` +
        `👆 Cliquem nos botões acima para votar no filme **${cached.movieKey}**!`,
      allowedMentions: { users: usuariosFaltam },
    });
    return;
  }

  if (customId === "session_confirm" || customId === "session_cancel") {
    const pending = pendingSessionCache.get(interaction.message.id);
    if (!pending) {
      await interaction.reply({ content: "❌ Esta confirmação expirou.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (customId === "session_cancel") {
      pendingSessionCache.delete(interaction.message.id);
      await interaction.update({ content: "❌ Sessão cancelada.", embeds: [], components: [] });
      return;
    }

    await interaction.update({ content: "⏳ Processando solicitação...", embeds: [], components: [] });

    if (!interaction.channel) {
      await interaction.editReply({ content: "❌ Erro: Canal não identificado." });
      return;
    }

    let publicMessage;
    try {
      if (!interaction.channel || !(interaction.channel instanceof TextChannel || interaction.channel instanceof NewsChannel)) {
        await interaction.editReply({ content: "❌ Erro: Canal inválido (não é um canal de texto de servidor)." });
        return;
      }
      publicMessage = await interaction.channel.send({ content: "⏳ Criando sessão..." });
    } catch (error) {
      await interaction.editReply({ content: "❌ Erro ao postar no canal (verifique permissões)." });
      return;
    }
    let selectedEpisodeInfo: SelectedEpisode | undefined;

    if (pending.tmdbInfo.seasons && pending.selectedSeason && pending.selectedEpisode) {
      const season = pending.tmdbInfo.seasons.find((s) => s.seasonNumber === pending.selectedSeason);
      if (season) {
        const episode = season.episodes.find((ep) => ep.episodeNumber === pending.selectedEpisode);
        if (episode) {
          selectedEpisodeInfo = {
            ...episode,
            seasonNumber: pending.selectedSeason
          };
        }
      }
    }

    let displayTitle = pending.tmdbInfo.title;
    if (selectedEpisodeInfo && selectedEpisodeInfo.seasonNumber) {
      displayTitle += ` - T${selectedEpisodeInfo.seasonNumber}E${selectedEpisodeInfo.episodeNumber}`;
    }

    const result = await playerApi.createDiscordSession({
      title: pending.sessionTitle,
      movieName: displayTitle,
      movieInfo: {
        id: pending.tmdbInfo.id,
        title: pending.tmdbInfo.title,
        overview: pending.tmdbInfo.overview,
        posterUrl: pending.tmdbInfo.poster_url,
        backdropUrl: null,
        releaseDate: pending.tmdbInfo.release_date,
        voteAverage: pending.tmdbInfo.vote_average,
        genres: pending.tmdbInfo.genres,
        mediaType: pending.tmdbInfo.media_type,
        seasons: pending.tmdbInfo.seasons,
      },
      discordSession: {
        channelId: pending.channelId,
        messageId: publicMessage.id,
        guildId: pending.guildId,
        hostDiscordId: pending.hostId,
        hostUsername: pending.hostUsername
      },
      selectedEpisode: selectedEpisodeInfo,
    });

    if (!result) {
      await publicMessage.delete().catch(() => { });
      await interaction.editReply({ content: "❌ Erro ao criar sessão. O servidor pode estar offline." });
      pendingSessionCache.delete(interaction.message.id);
      return;
    }

    setActiveWatchSession({
      roomId: result.roomId,
      hostToken: result.hostToken,
      hostDiscordId: pending.hostId,
      channelId: pending.channelId,
      messageId: publicMessage.id,
      guildId: pending.guildId,
      movieName: displayTitle,
      tmdbInfo: pending.tmdbInfo,
      selectedEpisode: selectedEpisodeInfo,
      hostUsername: pending.hostUsername,
      createdAt: Date.now()
    });

    const embed = buildSessionEmbed(
      displayTitle,
      pending.tmdbInfo,
      "waiting",
      pending.hostUsername,
      0,
      [],
      selectedEpisodeInfo,
      Date.now()
    );

    await publicMessage.edit({
      content: null,
      embeds: [embed],
      components: buildSessionComponents(result.roomId, "waiting", playerApi.getPlayerUrl()),
    });

    await interaction.editReply({
      content: `✅ **Sessão criada!**\nO painel de controle foi enviado no canal <#${pending.channelId}>.`
    });

    pendingSessionCache.delete(interaction.message.id);
    return;
  }

  if (customId === "list_prev" || customId === "list_next") {
    const cached = listCache.get(interaction.message.id);
    if (!cached) {
      await interaction.reply({ content: "❌ Esta lista expirou.", flags: MessageFlags.Ephemeral });
      return;
    }

    const perPage = 5;
    const maxPages = cached.movies.length ? Math.floor((cached.movies.length - 1) / perPage) + 1 : 1;
    const nextPage = customId === "list_next" ? cached.page + 1 : cached.page - 1;
    if (nextPage < 0 || nextPage >= maxPages) {
      await interaction.deferUpdate();
      return;
    }

    const embed = buildListEmbed(cached.movies, nextPage, cached.botAvatarUrl);
    const components = buildListComponents(cached.movies, nextPage);
    cached.page = nextPage;

    await interaction.update({ embeds: [embed], components });
    return;
  }

  if (customId === "watch_prev" || customId === "watch_next") {
    const cached = watchlistCache.get(interaction.message.id);
    if (!cached) {
      await interaction.reply({ content: "❌ Esta lista expirou.", flags: MessageFlags.Ephemeral });
      return;
    }

    const perPage = 5;
    const { total } = await db.getWatchlist(0, perPage);
    const maxPages = total ? Math.floor((total - 1) / perPage) + 1 : 1;
    const nextPage = customId === "watch_next" ? cached.page + 1 : cached.page - 1;
    if (nextPage < 0 || nextPage >= maxPages) {
      await interaction.deferUpdate();
      return;
    }

    const { items: nextItems, total: nextTotal } = await db.getWatchlist(nextPage, perPage);
    const embed = buildWatchlistEmbed(nextItems, nextTotal, cached.botAvatarUrl ?? null, nextPage);
    const components = buildWatchlistComponents(nextPage, nextTotal);
    cached.page = nextPage;

    await interaction.update({ embeds: [embed], components });
  }
};
