import { EmbedBuilder, Guild } from "discord.js";
import db from "../../database";
import { formatWatchDate } from "../utils";
import { searchMovieTmdb } from "../services/tmdb";
import { searchTrailerYoutube } from "../services/youtube";

export const buildMovieVoteEmbed = async (
  movieKey: string,
  tmdbInfo: any,
  allowedUsers: string[],
  guild: any
) => {
  const ratings = await db.getMovieRatings(movieKey);
  const embed = new EmbedBuilder().setTitle(`🎬 ${movieKey}`).setColor(0x9370db);

  if (tmdbInfo) {
    if (tmdbInfo.overview) {
      const overview = tmdbInfo.overview.length > 300 ? `${tmdbInfo.overview.slice(0, 297)}...` : tmdbInfo.overview;
      embed.setDescription(`*${overview}*`);
    }

    if (tmdbInfo.poster_url) {
      embed.setThumbnail(tmdbInfo.poster_url);
    }

    if (tmdbInfo.release_date) {
      embed.addFields({ name: "📅 Ano", value: tmdbInfo.release_date.slice(0, 4), inline: true });
    }

    if (tmdbInfo.vote_average) {
      embed.addFields({ name: "⭐ TMDB", value: `${tmdbInfo.vote_average.toFixed(1)}/10`, inline: true });
    }

    if (tmdbInfo.genres?.length) {
      embed.addFields({ name: "🎭 Gêneros", value: tmdbInfo.genres.join(", "), inline: false });
    }
  }

  if (ratings.length) {
    const notas = ratings.map((rating: any) => rating.score);
    const media = notas.reduce((acc: number, value: number) => acc + value, 0) / notas.length;
    const stars = "★".repeat(Math.round(media / 2)) + "☆".repeat(5 - Math.round(media / 2));

    embed.addFields({ name: "📊 Média do Grupo", value: `${stars}\n**${media.toFixed(1)}/10**`, inline: false });

    const votosTexto = ratings
      .map(
        (rating: any) =>
          `✅ **${rating.user_name}**: ${"⭐".repeat(Math.floor(rating.score / 2))} ${rating.score}/10`
      )
      .join("\n");

    if (votosTexto) {
      embed.addFields({ name: "🗳️ Votos", value: votosTexto, inline: false });
    }
  }

  const usuariosVotaram = new Set(ratings.map((rating: any) => String(rating.user_id)));
  const usuariosFaltam = allowedUsers.filter((uid) => !usuariosVotaram.has(uid));

  if (usuariosFaltam.length && guild) {
    const nomes: string[] = [];
    for (const uid of usuariosFaltam) {
      const member = guild.members.cache.get(uid);
      nomes.push(member?.displayName || `<@${uid}>`);
    }
    embed.addFields({ name: "⏳ Aguardando voto", value: nomes.join(" • "), inline: false });
  }

  const totalVotos = ratings.length;
  const totalPermitidos = allowedUsers.length;
  const status = totalVotos >= totalPermitidos ? "✅ Votação completa!" : `⏳ ${totalVotos}/${totalPermitidos} votos`;
  embed.setFooter({ text: `${status} • Clique em um número para votar` });

  return embed;
};

export const buildListEmbed = (filmes: any[], page: number, botAvatarUrl?: string | null) => {
  const perPage = 5;
  const maxPages = filmes.length ? Math.floor((filmes.length - 1) / perPage) + 1 : 1;
  const start = page * perPage;
  const end = start + perPage;
  const pageFilmes = filmes.slice(start, end);

  const embed = new EmbedBuilder()
    .setTitle("🎬 Filmes Assistidos")
    .setColor(0x3498db)
    .setFooter({ text: `Página ${page + 1}/${maxPages} • Total: ${filmes.length} filmes` });

  if (botAvatarUrl) {
    embed.setThumbnail(botAvatarUrl);
  }

  if (!pageFilmes.length) {
    embed.setDescription("Nenhum filme registrado ainda!");
    return embed;
  }

  for (const filme of pageFilmes) {
    const notas = filme.avaliacoes.map((rating: any) => rating.score);
    const media = notas.length ? notas.reduce((acc: number, value: number) => acc + value, 0) / notas.length : 0;
    const stars = "⭐".repeat(Math.round(media / 2));

    const isSeries = filme.isSeries;
    const icon = isSeries ? "📺" : "🎥";
    const title = isSeries ? `${filme.title} (Série)` : filme.title;

    let watchedText = "";
    if (isSeries && filme.episodes) {
      watchedText = ` • ${filme.episodes.length} episódios`;
    } else {
      const watchedDate = formatWatchDate(filme.watched_at);
      watchedText = watchedDate ? ` • 📅 ${watchedDate}` : "";
    }

    embed.addFields({
      name: `${icon} ${title}`,
      value: `${stars} **${media.toFixed(1)}/10** (${notas.length} votos)${watchedText}`,
      inline: false,
    });
  }

  return embed;
};

export const buildWatchlistEmbed = (items: any[], total: number, botAvatarUrl: string | null, page: number) => {
  const perPage = 5;
  const maxPages = total ? Math.floor((total - 1) / perPage) + 1 : 1;
  const embed = new EmbedBuilder()
    .setTitle("📜 Quero Assistir (Watchlist)")
    .setDescription(`Total: **${total} filmes** na lista`)
    .setColor(0x1abc9c)
    .setFooter({ text: `Página ${page + 1}/${maxPages}` });

  if (botAvatarUrl) {
    embed.setThumbnail(botAvatarUrl);
  }

  if (!items.length) {
    embed.setDescription("Nenhum filme na lista de interesse ainda!");
    return embed;
  }

  items.forEach((item: any) => {
    const addedDate = new Date(item.added_at).toLocaleDateString("pt-BR");
    const userDisplay = item.added_by_name ? `**${item.added_by_name}**` : `<@${item.added_by}>`;
    const genresText = item.genres ? `\n🎭 Gêneros: ${item.genres}` : "";
    const motivoBloco = item.recommendation_reason ? `\n💡 *Motivo: ${item.recommendation_reason}*` : "";

    embed.addFields({
      name: `📌 ${item.title}`,
      value: `👤 Add por ${userDisplay} em ${addedDate}${genresText}${motivoBloco}`,
      inline: false,
    });
  });

  return embed;
};

export const buildRecommendationsListEmbed = async (recomendacoes: { titulo: string; motivo: string }[]) => {
  const embed = new EmbedBuilder()
    .setTitle("🤖 Recomendações para o Grupo")
    .setDescription("Baseado no histórico de filmes assistidos e avaliações do grupo:")
    .setColor(0xf1c40f);

  for (let index = 0; index < recomendacoes.length; index++) {
    const rec = recomendacoes[index];
    const tmdbInfo = await searchMovieTmdb(rec.titulo);
    const sinopse = tmdbInfo?.overview
      ? (tmdbInfo.overview.length > 150 ? `${tmdbInfo.overview.slice(0, 147)}...` : tmdbInfo.overview)
      : "Sinopse não disponível.";

    embed.addFields({
      name: `${index + 1}. ${rec.titulo}`,
      value: `*${sinopse}*`,
      inline: false,
    });
  }

  embed.setFooter({ text: `${recomendacoes.length} recomendações • Selecione um filme para ver detalhes` });
  return embed;
};

export const buildRecommendationDetailEmbed = async (titulo: string, motivo: string) => {
  const tmdbInfo = await searchMovieTmdb(titulo);
  const embed = new EmbedBuilder().setTitle(`🎬 ${titulo}`).setColor(0xf1c40f);

  if (tmdbInfo?.overview) {
    const sinopse = tmdbInfo.overview.length > 400 ? `${tmdbInfo.overview.slice(0, 397)}...` : tmdbInfo.overview;
    embed.setDescription(`*${sinopse}*`);
  }

  let year = "";
  if (tmdbInfo) {
    if (tmdbInfo.poster_url) {
      embed.setImage(tmdbInfo.poster_url);
    }
    if (tmdbInfo.release_date) {
      year = tmdbInfo.release_date.slice(0, 4);
      embed.addFields({ name: "📅 Lançamento", value: year, inline: true });
    }
    if (tmdbInfo.vote_average) {
      embed.addFields({ name: "⭐ Nota TMDB", value: `${tmdbInfo.vote_average.toFixed(1)}/10`, inline: true });
    }
    if (tmdbInfo.genres?.length) {
      embed.addFields({ name: "🎭 Gêneros", value: tmdbInfo.genres.join(", "), inline: false });
    }
  }

  embed.addFields({ name: "💡 Por que assistir?", value: motivo, inline: false });

  const trailerUrl = await searchTrailerYoutube(titulo, year);
  if (trailerUrl) {
    embed.addFields({ name: "🎥 Trailer", value: `[Assistir no YouTube](${trailerUrl})`, inline: false });
  }

  return embed;
};

export const buildMovieDetailEmbed = (filme: any) => {
  const isSeries = filme.isSeries;
  const icon = isSeries ? "📺" : "🎬";
  const embed = new EmbedBuilder().setTitle(`${icon} ${filme.title}`).setColor(0xf1c40f);

  if (filme.overview) {
    embed.setDescription(`*${filme.overview}*`);
  }
  if (filme.poster_url) {
    embed.setThumbnail(filme.poster_url);
  }
  if (filme.release_date) {
    embed.addFields({ name: "📅 Lançamento", value: filme.release_date.slice(0, 4), inline: true });
  }

  if (!isSeries && filme.watched_at) {
    const watchDate = formatWatchDate(filme.watched_at) || "Data desconhecida";
    embed.addFields({ name: "📅 Assistido em", value: watchDate, inline: true });
  }

  if (filme.avaliacoes?.length) {
    const notas = filme.avaliacoes.map((av: any) => av.score);
    const media = notas.reduce((acc: number, value: number) => acc + value, 0) / notas.length;
    embed.addFields({ name: "⭐ Média Geral", value: `**${media.toFixed(1)}/10** (${notas.length} votos)`, inline: true });
  }

  if (filme.genres) {
    embed.addFields({ name: "🎭 Gêneros", value: filme.genres, inline: true });
  }

  if (isSeries && filme.episodes) {
    let episodesText = "";
    filme.episodes.forEach((ep: any) => {
      const epNotas = ep.avaliacoes.map((av: any) => av.score);
      const epMedia = epNotas.length ? (epNotas.reduce((a: number, b: number) => a + b, 0) / epNotas.length).toFixed(1) : "N/A";
      episodesText += `**T${ep.season}E${ep.episode}**: ⭐ ${epMedia} (${ep.avaliacoes.length} votos)\n`;
    });

    if (episodesText.length > 1024) {
      embed.addFields({ name: "📺 Episódios", value: episodesText.slice(0, 1021) + "...", inline: false });
    } else if (episodesText) {
      embed.addFields({ name: "📺 Episódios", value: episodesText, inline: false });
    }
  } else {
    if (filme.avaliacoes?.length) {
      const votos = filme.avaliacoes.map((av: any) => `👤 **${av.user_name}**: ${av.score}/10`).join("\n");
      embed.addFields({ name: "📝 Avaliações Individuais", value: votos || "Sem detalhes", inline: false });
    }
  }

  return embed;
};

export type SessionStatusType = "waiting" | "playing" | "ended";

interface SessionRating {
  discordId: string;
  username: string;
  rating: number;
}

export const buildSessionEmbed = (
  movieName: string,
  tmdbInfo: any,
  status: SessionStatusType,
  hostName: string,
  viewerCount: number = 0,
  ratings: SessionRating[] = [],
  selectedEpisode?: any,
  createdAt?: number
) => {
  const statusConfig: Record<SessionStatusType, { emoji: string; text: string; color: number }> = {
    waiting: { emoji: "⏳", text: "Aguardando host", color: 0xf39c12 },
    playing: { emoji: "🎬", text: "Em andamento", color: 0x2ecc71 },
    ended: { emoji: "✅", text: "Sessão concluída", color: 0x9b59b6 },
  };

  const config = statusConfig[status];
  let title = `${config.emoji} ${movieName}`;
  if (selectedEpisode && selectedEpisode.seasonNumber) {
    title += ` - T${selectedEpisode.seasonNumber}E${selectedEpisode.episodeNumber}`;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(config.color);

  if (tmdbInfo?.overview) {
    const overview = tmdbInfo.overview.length > 250
      ? `${tmdbInfo.overview.slice(0, 247)}...`
      : tmdbInfo.overview;
    embed.setDescription(`*${overview}*`);
  }

  if (tmdbInfo?.poster_url) {
    embed.setThumbnail(tmdbInfo.poster_url);
  }

  if (selectedEpisode) {
    const epText = `T${selectedEpisode.seasonNumber}E${selectedEpisode.episodeNumber} - ${selectedEpisode.name}`;
    embed.addFields({ name: "📺 Episódio", value: epText, inline: true });
  }

  if (tmdbInfo?.release_date) {
    embed.addFields({ name: "📅 Ano", value: tmdbInfo.release_date.slice(0, 4), inline: true });
  }

  if (tmdbInfo?.vote_average) {
    embed.addFields({ name: "⭐ TMDB", value: `${tmdbInfo.vote_average.toFixed(1)}/10`, inline: true });
  }

  if (tmdbInfo?.genres?.length) {
    embed.addFields({ name: "🎭 Gêneros", value: tmdbInfo.genres.join(", "), inline: false });
  }

  embed.addFields(
    { name: "📡 Status", value: config.text, inline: true },
    { name: "👤 Host", value: `${hostName}`, inline: true }
  );

  if (status !== "waiting") {
    embed.addFields({ name: "👥 Assistindo", value: `${viewerCount}`, inline: true });
  }

  if (status === "ended" && ratings.length > 0) {
    const average = ratings.reduce((acc, r) => acc + r.rating, 0) / ratings.length;
    const fullStars = Math.round(average);
    const starsAvg = "⭐".repeat(fullStars);

    embed.addFields({
      name: "📊 Média do Grupo",
      value: `${starsAvg} **${average.toFixed(1)}/10**`,
      inline: false
    });

    const votosTexto = ratings
      .map(r => `✅ **${r.username}**: ${"⭐".repeat(Math.round(r.rating))} ${r.rating}/10`)
      .join("\n");

    if (votosTexto) {
      embed.addFields({ name: "🗳️ Avaliações", value: votosTexto, inline: false });
    }
  }

  const footerText = status === "waiting"
    ? "Clique no botão abaixo para entrar na sessão"
    : status === "playing"
      ? "Sessão em andamento • Clique para assistir"
      : "Sessão encerrada • Obrigado por assistir!";

  if (createdAt) {
    const startTime = new Date(createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    embed.setFooter({ text: `${footerText} • Iniciada às ${startTime}` });
  } else {
    embed.setFooter({ text: footerText });
  }

  return embed;
};