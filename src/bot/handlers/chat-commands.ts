import {
  ActionRowBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from "discord.js";
import db from "../../database";
import { ADMIN_USER_ID } from "../../config";
import { searchMovieTmdb } from "../services/tmdb";
import { searchTrailerYoutube } from "../services/youtube";
import { buildRecommendations } from "../services/recommendations";
import {
  buildListComponents,
  buildWatchlistComponents,
  buildRecommendationSelectComponents,
  buildConfirmRow,
  buildRecommendationModal,
  buildChangelogComponents,
} from "../ui/components";
import {
  buildListEmbed,
  buildWatchlistEmbed,
  buildRecommendationsListEmbed,
  buildChangelogEmbed,
} from "../ui/embeds";
import { CHANGELOG_ENTRIES } from "../data/changelog";
import {
  listCache,
  watchlistCache,
  recCache,
  pendingWatchlistCache,
  pendingRemovalCache,
  pendingSessionCache,
  activeWatchSession,
} from "../state";

type CommandHandler = (interaction: ChatInputCommandInteraction) => Promise<void>;

async function handleHelp(interaction: ChatInputCommandInteraction): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle("🎬 Comandos do Filmaços")
    .setDescription("Aqui estão todos os comandos disponíveis:")
    .setColor(0x3498db)
    .addFields(
      {
        name: "🔍 /pesquisar `filme`",
        value: "Busca informações detalhadas sobre um filme incluindo sinopse, nota, gêneros e trailer.",
        inline: false,
      },
      {
        name: "📝 /registrar `filme` `espectadores`",
        value: "Cria uma votação para um filme assistido pelo grupo. Mencione os usuários que assistiram.",
        inline: false,
      },
      {
        name: "📋 /listar",
        value: "Mostra todos os filmes assistidos pelo grupo ordenados por nota.",
        inline: false,
      },
      {
        name: "⭐ /minhasavaliacoes",
        value: "Veja suas próprias avaliações e sua média pessoal.",
        inline: false,
      },
      {
        name: "🤖 /recomendar",
        value: "Receba recomendações de filmes baseadas no histórico do grupo. Quantidade e gênero são opcionais.",
        inline: false,
      },
      {
        name: "📌 /watchlist adicionar `filme` `motivo`",
        value: "Adiciona um filme à lista de interesse do grupo.",
        inline: false,
      },
      {
        name: "📜 /watchlist ver",
        value: "Visualiza a lista de filmes que o grupo quer assistir.",
        inline: false,
      },
      {
        name: "🗑️ /watchlist remover `filme`",
        value: "Remove um filme da watchlist.",
        inline: false,
      }
    );

  const avatarUrl = interaction.client.user?.displayAvatarURL();
  if (avatarUrl) {
    embed.setThumbnail(avatarUrl);
  }

  await interaction.reply({ embeds: [embed] });
}

async function handleSessao(interaction: ChatInputCommandInteraction): Promise<void> {
  if (activeWatchSession) {
    await interaction.reply({
      content: "❌ Já existe uma sessão ativa! Aguarde ela terminar antes de criar outra.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const modal = new ModalBuilder().setCustomId("session_create").setTitle("🎬 Criar Sessão");

  const movieInput = new TextInputBuilder()
    .setCustomId("session_movie")
    .setLabel("Nome do filme ou série")
    .setPlaceholder("Ex: Oppenheimer")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(movieInput)
  );

  await interaction.showModal(modal);
}

async function handlePesquisar(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const filme = interaction.options.getString("filme", true);
  const tmdbInfo = await searchMovieTmdb(filme);

  if (!tmdbInfo) {
    await interaction.followUp({ content: `❌ Filme **${filme}** não encontrado no TMDB.`, flags: MessageFlags.Ephemeral });
    return;
  }

  const year = tmdbInfo.release_date?.slice(0, 4) || "";
  const embed = new EmbedBuilder()
    .setTitle(`🎬 ${tmdbInfo.title}`)
    .setColor(0xffc300)
    .setDescription(tmdbInfo.overview ? `*${tmdbInfo.overview}*` : null);

  if (tmdbInfo.poster_url) {
    embed.setImage(tmdbInfo.poster_url);
  }

  if (year) {
    embed.addFields({ name: "📅 Ano", value: year, inline: true });
  }

  if (tmdbInfo.vote_average) {
    const nota = tmdbInfo.vote_average;
    const stars = "★".repeat(Math.round(nota / 2)) + "☆".repeat(5 - Math.round(nota / 2));
    embed.addFields({ name: "⭐ Nota TMDB", value: `${stars}\n**${nota.toFixed(1)}/10**`, inline: true });
  }

  if (tmdbInfo.genres?.length) {
    embed.addFields({ name: "🎭 Gêneros", value: tmdbInfo.genres.join(", "), inline: false });
  }

  const trailerUrl = await searchTrailerYoutube(tmdbInfo.title, year);
  if (trailerUrl) {
    embed.addFields({ name: "🎥 Trailer", value: `[Assistir no YouTube](${trailerUrl})`, inline: false });
  }

  await interaction.followUp({ embeds: [embed] });
}

async function handleListar(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const filmes = await db.getAllMoviesWithRatings();
  filmes.sort((a, b) => {
    const mediaA = a.avaliacoes.length
      ? a.avaliacoes.reduce((acc, av) => acc + av.score, 0) / a.avaliacoes.length
      : 0;
    const mediaB = b.avaliacoes.length
      ? b.avaliacoes.reduce((acc, av) => acc + av.score, 0) / b.avaliacoes.length
      : 0;
    return mediaB - mediaA;
  });

  const page = 0;
  const embed = buildListEmbed(filmes, page, interaction.client.user?.displayAvatarURL());
  const components = buildListComponents(filmes, page);
  await interaction.editReply({ embeds: [embed], components });
  const message = await interaction.fetchReply();

  listCache.set(message.id, {
    movies: filmes,
    page,
    botAvatarUrl: interaction.client.user?.displayAvatarURL(),
  });
}

async function handleWatchlist(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === "adicionar") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const filme = interaction.options.getString("filme", true);
    const motivo = interaction.options.getString("motivo") || "";

    const tmdbInfo = await searchMovieTmdb(filme);
    if (!tmdbInfo) {
      await interaction.followUp({ content: "❌ Filme não encontrado no TMDB.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (await db.isMovieWatched(tmdbInfo.title, tmdbInfo.id)) {
      await interaction.followUp({
        content: `⚠️ O filme **${tmdbInfo.title}** já foi assistido pelo grupo! Use \`/listar\` para ver.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const embed = new EmbedBuilder().setTitle(`🎬 ${tmdbInfo.title}`).setColor(0x1abc9c);
    if (tmdbInfo.overview) {
      embed.setDescription(`${tmdbInfo.overview.slice(0, 200)}...`);
    }
    if (tmdbInfo.poster_url) {
      embed.setThumbnail(tmdbInfo.poster_url);
    }
    embed.addFields({ name: "Data Lançamento", value: tmdbInfo.release_date || "?", inline: true });
    if (tmdbInfo.genres?.length) {
      embed.addFields({ name: "🎭 Gêneros", value: tmdbInfo.genres.join(", "), inline: true });
    }
    if (motivo) {
      embed.addFields({ name: "Motivo", value: motivo, inline: false });
    }

    const components = buildConfirmRow(
      "watch_add_confirm",
      "watch_add_cancel",
      "✅ Adicionar à Lista",
      "❌ Cancelar"
    );

    const message = await interaction.followUp({
      content: "Deseja adicionar este filme à lista de interesse?",
      embeds: [embed],
      components,
      flags: MessageFlags.Ephemeral,
    });

    pendingWatchlistCache.set(message.id, {
      tmdbInfo,
      userId: interaction.user.id,
      userName: interaction.member instanceof GuildMember
        ? interaction.member.displayName
        : interaction.user.username,
      reason: motivo,
    });
    return;
  }

  if (sub === "ver") {
    const { items, total } = await db.getWatchlist(0, 5);
    const page = 0;
    const embed = buildWatchlistEmbed(items, total, interaction.client.user?.displayAvatarURL(), page);
    const components = buildWatchlistComponents(page, total);
    await interaction.reply({ embeds: [embed], components });
    const message = await interaction.fetchReply();

    watchlistCache.set(message.id, {
      page,
      botAvatarUrl: interaction.client.user?.displayAvatarURL(),
    });
    return;
  }

  if (sub === "remover") {
    const filme = interaction.options.getString("filme", true);
    const result = await db.removeFromWatchlist(filme, interaction.user.id);

    if (result === "deleted") {
      await interaction.reply({ content: `✅ **${filme}** removido da watchlist!`, flags: MessageFlags.Ephemeral });
    } else if (result === "not_owner") {
      await interaction.reply({ content: "❌ Você só pode remover filmes que **você adicionou**!", flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: `❌ **${filme}** não encontrado na watchlist!`, flags: MessageFlags.Ephemeral });
    }
  }
}

async function handleMinhasAvaliacoes(interaction: ChatInputCommandInteraction): Promise<void> {
  const filmes = await db.getAllMoviesWithRatings();
  const userId = String(interaction.user.id);

  const minhasNotas: { filme: string; nota: number; media: number; poster: string | null }[] = [];
  filmes.forEach((filme) => {
    const avaliacao = filme.avaliacoes.find((av) => av.user_id === userId);
    if (avaliacao) {
      const notasFilme = filme.avaliacoes.map((av) => av.score);
      const mediaFilme = notasFilme.reduce((acc, value) => acc + value, 0) / notasFilme.length;
      minhasNotas.push({
        filme: filme.title,
        nota: avaliacao.score,
        media: mediaFilme,
        poster: filme.poster_url,
      });
    }
  });

  if (!minhasNotas.length) {
    await interaction.reply({ content: "❌ Você ainda não avaliou nenhum filme!", flags: MessageFlags.Ephemeral });
    return;
  }

  minhasNotas.sort((a, b) => b.nota - a.nota);

  const embed = new EmbedBuilder()
    .setTitle(`🎬 Avaliações de ${interaction.member instanceof GuildMember ? interaction.member.displayName : interaction.user.username}`)
    .setDescription(`Total: **${minhasNotas.length} filmes** avaliados`)
    .setColor(0x9b59b6);

  const notasTexto = minhasNotas
    .slice(0, 15)
    .map((item) => {
      const diff = item.nota - item.media;
      const diffStr = diff > 0 ? `(+${diff.toFixed(1)})` : diff < 0 ? `(${diff.toFixed(1)})` : "(=)";
      return `**${item.filme}**: ⭐ ${item.nota}/10 ${diffStr}`;
    })
    .join("\n");

  embed.addFields({ name: "📊 Suas Notas", value: notasTexto || "Nenhuma", inline: false });

  const mediaPessoal = minhasNotas.reduce((acc, value) => acc + value.nota, 0) / minhasNotas.length;
  embed.addFields({ name: "📈 Sua Média Geral", value: `**${mediaPessoal.toFixed(1)}/10**`, inline: true });

  const posters = minhasNotas.map((item) => item.poster).filter(Boolean);
  if (posters.length) {
    const poster = posters[Math.floor(Math.random() * posters.length)];
    embed.setThumbnail(poster);
  }

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleRemover(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.user.id !== ADMIN_USER_ID) {
    await interaction.reply({ content: "❌ Apenas o administrador pode remover filmes!", flags: MessageFlags.Ephemeral });
    return;
  }

  const filme = interaction.options.getString("filme", true);
  const filmes = await db.getAllMoviesWithRatings();
  const found = filmes.find((movie) => movie.title.toLowerCase().includes(filme.toLowerCase()));
  if (!found) {
    await interaction.reply({ content: `❌ Filme **${filme}** não encontrado!`, flags: MessageFlags.Ephemeral });
    return;
  }

  const modal = new ModalBuilder().setCustomId("remove_confirm").setTitle("🗑️ Confirmar Remoção");
  const input = new TextInputBuilder()
    .setCustomId("remove_confirm_input")
    .setLabel("Digite o nome do filme para confirmar")
    .setPlaceholder("Nome exato do filme")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  pendingRemovalCache.set(interaction.user.id, found.title);
  await interaction.showModal(modal);
}

async function handleRecomendar(interaction: ChatInputCommandInteraction): Promise<void> {
  const filmesDb = await db.getAllMoviesWithRatings();
  if (!filmesDb.length) {
    await interaction.reply({
      content: "❌ Nenhum filme registrado ainda! Registre alguns filmes primeiro usando `/registrar`.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.showModal(buildRecommendationModal());
}

async function handleChangelog(interaction: ChatInputCommandInteraction): Promise<void> {
  const pageIndex = 0;
  const entry = CHANGELOG_ENTRIES[pageIndex];
  const embed = buildChangelogEmbed(entry, pageIndex);
  const components = buildChangelogComponents(pageIndex, CHANGELOG_ENTRIES.length);
  await interaction.reply({ embeds: [embed], components });
}

const handlers: Record<string, CommandHandler> = {
  help: handleHelp,
  sessao: handleSessao,
  pesquisar: handlePesquisar,
  listar: handleListar,
  watchlist: handleWatchlist,
  minhasavaliacoes: handleMinhasAvaliacoes,
  remover: handleRemover,
  recomendar: handleRecomendar,
  changelog: handleChangelog,
};

export const handleChatInputCommand = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  const handler = handlers[interaction.commandName];
  if (handler) await handler(interaction);
};
