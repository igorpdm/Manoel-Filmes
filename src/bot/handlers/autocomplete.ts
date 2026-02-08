import { AutocompleteInteraction } from "discord.js";
import db from "../../database";
import { searchMovieTmdb } from "../services/tmdb";

export const handleAutocomplete = async (interaction: any) => {
  if (interaction.commandName === "remover") {
    const current = interaction.options.getString("filme") || "";
    const filmes = (await db.getAllMoviesWithRatings()).map((movie: any) => movie.title);
    const filtered = current
      ? filmes.filter((title: string) => title.toLowerCase().includes(current.toLowerCase()))
      : filmes;

    await interaction.respond(
      filtered.slice(0, 25).map((title: string) => ({ name: title.slice(0, 100), value: title.slice(0, 100) }))
    );
  }
};
