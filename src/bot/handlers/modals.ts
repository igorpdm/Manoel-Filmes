import { GuildMember, ModalSubmitInteraction, MessageFlags } from "discord.js";
import db from "../../database";
import { searchMovieTmdb } from "../services/tmdb";
import { buildRecommendations } from "../services/recommendations";
import {
  pendingWatchlistCache,
  pendingRemovalCache,
  pendingSessionCache,
  activeWatchSession,
  recCache,
} from "../state";
import { buildRecommendationLoadingEmbed, buildRecommendationsListEmbed, buildSessionEmbed } from "../ui/embeds";
import { buildEpisodeSelectComponents, buildRecommendationSelectComponents, buildSessionConfirmComponents } from "../ui/components";

export const handleModalSubmit = async (interaction: ModalSubmitInteraction) => {
  if (interaction.customId === "recommend_modal") {
    const quantidade = Number(interaction.fields.getStringSelectValues("recommend_quantity")[0] || "5");
    const generoValue = interaction.fields.getStringSelectValues("recommend_genre")[0] || "all";
    const includeSeriesValue = interaction.fields.getStringSelectValues("recommend_include_series")[0] || "no";
    const genero = generoValue === "all" ? null : generoValue;
    const includeSeries = includeSeriesValue === "yes";

    await interaction.reply({
      embeds: [
        buildRecommendationLoadingEmbed(
          quantidade,
          genero,
          includeSeries,
          "Analisando historico",
          "Estou montando o perfil do grupo antes de buscar novas recomendacoes."
        ),
      ],
    });

    const progressMessage = await interaction.fetchReply();

    try {
      const movies = await db.getAllMoviesWithRatings();
      const recomendacoes = await buildRecommendations(movies, quantidade, genero, includeSeries, {
        onProgress: async ({ step, detail }) => {
          await interaction.editReply({
            embeds: [buildRecommendationLoadingEmbed(quantidade, genero, includeSeries, step, detail)],
            components: [],
          });
        },
      });

      if (!recomendacoes.length) {
        await interaction.editReply({
          content: "❌ Não foi possível gerar recomendações com esses filtros.",
          embeds: [],
          components: [],
        });
        return;
      }

      const embed = await buildRecommendationsListEmbed(recomendacoes);
      const components = buildRecommendationSelectComponents(recomendacoes);
      await interaction.editReply({ content: undefined, embeds: [embed], components });
      recCache.set(progressMessage.id, { recommendations: recomendacoes });
    } catch (error: any) {
      await interaction.editReply({
        content: `❌ Erro ao gerar recomendações: ${error.message}`,
        embeds: [],
        components: [],
      });
    }

    return;
  }

  if (interaction.customId === "session_create") {
    if (activeWatchSession) {
      await interaction.reply({
        content: "❌ Já existe uma sessão ativa! Aguarde ela terminar antes de criar outra.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sessionTitle = interaction.fields.getTextInputValue("session_title").trim() || "Sessão de Cinema";
    const movieQuery = interaction.fields.getTextInputValue("session_movie").trim();

    const tmdbInfo = await searchMovieTmdb(movieQuery);
    if (!tmdbInfo) {
      await interaction.followUp({ content: `❌ Filme **${movieQuery}** não encontrado no TMDB.`, flags: MessageFlags.Ephemeral });
      return;
    }

    const isSeries = tmdbInfo.media_type === "tv";
    const embed = buildSessionEmbed(tmdbInfo.title, tmdbInfo, "waiting", interaction.user.username, 0, []);
    embed.setDescription(`*${tmdbInfo.overview?.slice(0, 200) || ""}...*\n\n🎦 **Host:** ${interaction.user}`);

    if (isSeries && tmdbInfo.seasons?.length) {
      const components = buildEpisodeSelectComponents(tmdbInfo.seasons);
      const message = await interaction.followUp({
        content: "📺 Selecione a temporada e episódio:",
        embeds: [embed],
        components,
      });

      pendingSessionCache.set(message.id, {
        tmdbInfo,
        sessionTitle,
        hostId: interaction.user.id,
        hostUsername: interaction.member instanceof GuildMember
          ? interaction.member.displayName
          : interaction.user.username,
        channelId: interaction.channelId ?? "",
        guildId: interaction.guildId ?? "",
      });
      return;
    }

    const components = buildSessionConfirmComponents();
    const message = await interaction.followUp({
      content: "🎬 Confirma a criação da sessão?",
      embeds: [embed],
      components,
    });

    pendingSessionCache.set(message.id, {
      tmdbInfo,
      sessionTitle,
      hostId: interaction.user.id,
      hostUsername: interaction.member instanceof GuildMember
        ? interaction.member.displayName
        : interaction.user.username,
      channelId: interaction.channelId ?? "",
      guildId: interaction.guildId ?? "",
    });
    return;
  }

  if (interaction.customId === "remove_confirm") {
    const filme = pendingRemovalCache.get(interaction.user.id);
    pendingRemovalCache.delete(interaction.user.id);
    if (!filme) {
      await interaction.reply({ content: "❌ Esta confirmação expirou.", flags: MessageFlags.Ephemeral });
      return;
    }

    const confirmacao = interaction.fields.getTextInputValue("remove_confirm_input");
    if (confirmacao.trim().toLowerCase() !== String(filme).toLowerCase()) {
      await interaction.reply({ content: "❌ Nome incorreto! Remoção cancelada.", flags: MessageFlags.Ephemeral });
      return;
    }

    const deleted = await db.deleteMovie(filme);
    if (deleted) {
      await interaction.reply({ content: `✅ **${filme}** foi removido do histórico!`, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: "❌ Erro ao remover filme.", flags: MessageFlags.Ephemeral });
    }
  }
};
