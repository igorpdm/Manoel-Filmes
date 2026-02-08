import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from "discord.js";
import { getNotaEmoji, getButtonStyle } from "../utils";

export const buildVotingComponents = (movieId: string) => {
  const row1 = new ActionRowBuilder<ButtonBuilder>();
  const row2 = new ActionRowBuilder<ButtonBuilder>();

  for (let nota = 1; nota <= 10; nota += 1) {
    const button = new ButtonBuilder()
      .setCustomId(`vote:${movieId}:${nota}`)
      .setLabel(String(nota))
      .setEmoji(getNotaEmoji(nota))
      .setStyle(getButtonStyle(nota));

    if (nota <= 5) {
      row1.addComponents(button);
    } else {
      row2.addComponents(button);
    }
  }

  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`remind:${movieId}`)
      .setLabel("📢 Quem falta votar?")
      .setStyle(ButtonStyle.Secondary)
  );

  return [row1, row2, row3];
};

export const buildListComponents = (filmes: any[], page: number) => {
  const perPage = 5;
  const maxPages = filmes.length ? Math.floor((filmes.length - 1) / perPage) + 1 : 1;
  const start = page * perPage;
  const end = start + perPage;
  const pageFilmes = filmes.slice(start, end);

  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
  if (pageFilmes.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`list_select:${page}`)
      .setPlaceholder("🔍 Ver detalhes de um filme...")
      .setMinValues(1)
      .setMaxValues(1);

    pageFilmes.forEach((filme: any, index: number) => {
      const notas = filme.avaliacoes.map((rating: any) => rating.score);
      const media = notas.length ? notas.reduce((acc: number, value: number) => acc + value, 0) / notas.length : 0;
      select.addOptions({
        label: filme.title.slice(0, 100),
        description: `⭐ ${media.toFixed(1)}/10 (${notas.length} votos)`,
        value: String(index),
      });
    });

    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }

  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("list_prev")
      .setLabel("◀ Anterior")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId("list_next")
      .setLabel("Próximo ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= maxPages - 1)
  );

  rows.push(navRow);
  return rows;
};

export const buildWatchlistComponents = (page: number, total: number) => {
  const perPage = 5;
  const maxPages = total ? Math.floor((total - 1) / perPage) + 1 : 1;

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("watch_prev")
        .setLabel("◀ Anterior")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId("watch_next")
        .setLabel("Próximo ▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= maxPages - 1)
    ),
  ];
};

export const buildRecommendationSelectComponents = (recomendacoes: { titulo: string; motivo: string }[]) => {
  const select = new StringSelectMenuBuilder()
    .setCustomId("rec_select")
    .setPlaceholder("🔍 Ver detalhes de um filme...")
    .setMinValues(1)
    .setMaxValues(1);

  recomendacoes.forEach((rec, index) => {
    select.addOptions({
      label: rec.titulo.slice(0, 100),
      description: rec.motivo.slice(0, 100),
      value: String(index),
    });
  });

  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];
};

export const buildConfirmRow = (
  confirmId: string,
  cancelId: string,
  confirmLabel: string,
  cancelLabel: string
) => {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(confirmId).setLabel(confirmLabel).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cancelId).setLabel(cancelLabel).setStyle(ButtonStyle.Danger)
    ),
  ];
};

export const buildSessionComponents = (roomId: string, status: "waiting" | "playing" | "ended") => {
  if (status === "ended") {
    return [];
  }

  const buttonLabel = status === "waiting" ? "🎬 Entrar na Sessão" : "📺 Assistir Agora";

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`session_join:${roomId}`)
        .setLabel(buttonLabel)
        .setStyle(ButtonStyle.Primary)
    ),
  ];
};

export const buildSessionConfirmComponents = () => {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("session_confirm")
        .setLabel("✅ Criar Sessão")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("session_cancel")
        .setLabel("❌ Cancelar")
        .setStyle(ButtonStyle.Danger)
    ),
  ];
};

export const buildEpisodeSelectComponents = (
  seasons: any[],
  selectedSeason?: number,
  episodes?: any[],
  selectedEpisode?: number
) => {
  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];

  const seasonSelect = new StringSelectMenuBuilder()
    .setCustomId("session_season_select")
    .setPlaceholder("📺 Selecione a temporada...")
    .setMinValues(1)
    .setMaxValues(1);

  seasons.forEach((season: any) => {
    seasonSelect.addOptions({
      label: season.name || `Temporada ${season.seasonNumber}`,
      description: `${season.episodeCount || season.episodes?.length || 0} episódios`,
      value: String(season.seasonNumber),
      default: selectedSeason ? String(season.seasonNumber) === String(selectedSeason) : false,
    });
  });

  rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(seasonSelect));

  if (episodes && episodes.length > 0) {
    const episodeSelect = new StringSelectMenuBuilder()
      .setCustomId("session_episode_select")
      .setPlaceholder("🎬 Selecione o episódio...")
      .setMinValues(1)
      .setMaxValues(1);

    episodes.slice(0, 25).forEach((ep: any) => {
      episodeSelect.addOptions({
        label: `${ep.episodeNumber}. ${ep.name}`.slice(0, 100),
        description: (ep.overview ? ep.overview.slice(0, 95) + "..." : "Sem descrição"),
        value: String(ep.episodeNumber),
        default: selectedEpisode ? String(ep.episodeNumber) === String(selectedEpisode) : false,
      });
    });

    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(episodeSelect));
  }

  const buttonRow = new ActionRowBuilder<ButtonBuilder>();

  if (selectedSeason && selectedEpisode) {
    buttonRow.addComponents(
      new ButtonBuilder()
        .setCustomId("session_confirm")
        .setLabel("✅ Confirmar Sessão")
        .setStyle(ButtonStyle.Success)
    );
  }

  buttonRow.addComponents(
    new ButtonBuilder()
      .setCustomId("session_cancel")
      .setLabel("❌ Cancelar")
      .setStyle(ButtonStyle.Danger)
  );

  rows.push(buttonRow);

  return rows;
};