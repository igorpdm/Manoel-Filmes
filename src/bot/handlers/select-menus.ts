import { MessageFlags } from "discord.js";
import { buildEpisodeSelectComponents } from "../ui/components";
import { buildMovieDetailEmbed, buildRecommendationDetailEmbed } from "../ui/embeds";
import { listCache, pendingSessionCache, recCache } from "../state";

export const handleSelectMenu = async (interaction: any) => {
  if (
    interaction.customId === "session_season_select" ||
    interaction.customId === "session_episode_select"
  ) {
    const pending = pendingSessionCache.get(interaction.message.id);
    if (!pending) {
      await interaction.reply({ content: "❌ Esta sessão expirou.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferUpdate();

    if (interaction.customId === "session_season_select") {
      const seasonNumber = Number(interaction.values[0]);
      pending.selectedSeason = seasonNumber;
      pending.selectedEpisode = undefined;

      const season = pending.tmdbInfo.seasons.find((s: any) => s.seasonNumber === seasonNumber);
      const episodes = season ? season.episodes : [];

      const components = buildEpisodeSelectComponents(
        pending.tmdbInfo.seasons,
        pending.selectedSeason,
        episodes,
        pending.selectedEpisode
      );

      await interaction.editReply({ components });
    } else if (interaction.customId === "session_episode_select") {
      const episodeNumber = Number(interaction.values[0]);
      pending.selectedEpisode = episodeNumber;

      const season = pending.tmdbInfo.seasons.find((s: any) => s.seasonNumber === pending.selectedSeason);
      const episodes = season ? season.episodes : [];

      const components = buildEpisodeSelectComponents(
        pending.tmdbInfo.seasons,
        pending.selectedSeason,
        episodes,
        pending.selectedEpisode
      );

      await interaction.editReply({ components });
    }
    return;
  }

  if (interaction.customId === "rec_select") {
    const cached = recCache.get(interaction.message.id);
    if (!cached) {
      await interaction.reply({ content: "❌ Esta recomendação expirou. Use `/recomendar` novamente.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply();

    const index = Number(interaction.values[0]);
    const rec = cached.recomendacoes[index];
    if (!rec) {
      await interaction.followUp({ content: "❌ Filme não encontrado." });
      return;
    }

    const embed = await buildRecommendationDetailEmbed(rec.titulo, rec.motivo);
    await interaction.followUp({ embeds: [embed] });
    return;
  }

  if (interaction.customId.startsWith("list_select:")) {
    const cached = listCache.get(interaction.message.id);
    if (!cached) {
      await interaction.reply({ content: "❌ Esta lista expirou.", flags: MessageFlags.Ephemeral });
      return;
    }

    const page = Number(interaction.customId.split(":")[1]);
    const index = Number(interaction.values[0]);
    const start = page * 5;
    const filme = cached.filmes[start + index];

    if (!filme) {
      await interaction.reply({ content: "❌ Filme não encontrado.", flags: MessageFlags.Ephemeral });
      return;
    }

    const embed = buildMovieDetailEmbed(filme);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
};
