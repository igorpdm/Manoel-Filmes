import { ModalSubmitInteraction, MessageFlags } from "discord.js";
import db from "../../database";
import { searchMovieTmdb } from "../services/tmdb";
import {
  pendingWatchlistCache,
  pendingRemovalCache,
  pendingSessionCache,
  activeWatchSession,
} from "../state";
import { buildSessionEmbed } from "../ui/embeds";
import { buildEpisodeSelectComponents, buildSessionConfirmComponents } from "../ui/components";

export const handleModalSubmit = async (interaction: any) => {
  if (interaction.customId === "session_create") {
    if (activeWatchSession) {
      await interaction.reply({
        content: "❌ Já existe uma sessão ativa! Aguarde ela terminar antes de criar outra.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sala = interaction.fields.getTextInputValue("session_title").trim() || "Sessão de Cinema";
    const filme = interaction.fields.getTextInputValue("session_movie").trim();

    const tmdbInfo = await searchMovieTmdb(filme);
    if (!tmdbInfo) {
      await interaction.followUp({ content: `❌ Filme **${filme}** não encontrado no TMDB.`, flags: MessageFlags.Ephemeral });
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
        sala,
        hostId: interaction.user.id,
        hostUsername: interaction.member?.displayName ?? interaction.user.username,
        channelId: interaction.channelId,
        guildId: interaction.guildId,
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
      sala,
      hostId: interaction.user.id,
      hostUsername: interaction.member?.displayName ?? interaction.user.username,
      channelId: interaction.channelId,
      guildId: interaction.guildId,
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
