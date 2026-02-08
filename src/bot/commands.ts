import { SlashCommandBuilder } from "discord.js";

export const registerCommands = async (client: any) => {
  const commands = [
    new SlashCommandBuilder().setName("help").setDescription("Ver todos os comandos disponíveis do bot"),
    new SlashCommandBuilder()
      .setName("pesquisar")
      .setDescription("Pesquisar informações detalhadas sobre um filme")
      .addStringOption((option) => option.setName("filme").setDescription("Nome do filme").setRequired(true)),
    new SlashCommandBuilder()
      .setName("registrar")
      .setDescription("Criar votação para um filme assistido pelo grupo")
      .addStringOption((option) => option.setName("filme").setDescription("Nome do filme").setRequired(true))
      .addStringOption((option) =>
        option
          .setName("espectadores")
          .setDescription("Mencione os usuários que assistiram (@user1 @user2 ...)")
          .setRequired(true)
      ),
    new SlashCommandBuilder().setName("listar").setDescription("Ver todos os filmes assistidos pelo grupo"),
    new SlashCommandBuilder().setName("minhasavaliacoes").setDescription("Ver suas próprias avaliações"),
    new SlashCommandBuilder()
      .setName("remover")
      .setDescription("Remover um filme do histórico (apenas admin)")
      .addStringOption((option) =>
        option.setName("filme").setDescription("Nome do filme para remover").setRequired(true).setAutocomplete(true)
      ),
    new SlashCommandBuilder()
      .setName("recomendar")
      .setDescription("Receber recomendações de filmes baseadas no histórico do grupo")
      .addIntegerOption((option) =>
        option
          .setName("quantidade")
          .setDescription("Número de recomendações (1-10, padrão: 5)")
          .setMinValue(1)
          .setMaxValue(10)
      )
      .addStringOption((option) => option.setName("genero").setDescription("Gênero específico (opcional)")),
    new SlashCommandBuilder()
      .setName("watchlist")
      .setDescription("Gerenciar lista de filmes para assistir")
      .addSubcommand((sub) =>
        sub
          .setName("adicionar")
          .setDescription("Adiciona um filme à lista de interesse")
          .addStringOption((option) => option.setName("filme").setDescription("Nome do filme").setRequired(true))
          .addStringOption((option) => option.setName("motivo").setDescription("Motivo do interesse"))
      )
      .addSubcommand((sub) => sub.setName("ver").setDescription("Ver filmes na lista de interesse"))
      .addSubcommand((sub) =>
        sub
          .setName("remover")
          .setDescription("Remove um filme da watchlist")
          .addStringOption((option) => option.setName("filme").setDescription("Nome do filme").setRequired(true))
      ),
    new SlashCommandBuilder()
      .setName("sessao")
      .setDescription("Criar uma sessão de cinema para assistir junto"),
  ];

  await client.application.commands.set(commands.map((cmd) => cmd.toJSON()));
};