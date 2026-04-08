import { initDb, migrateFromJson } from "./schema";
import { registerMovieStart, addVote, getMovieRatings, getAllMoviesWithRatings, deleteMovie, isMovieWatched } from "./movies";
import { addToWatchlist, getWatchlist, removeFromWatchlist, removeFromWatchlistByTitle } from "./watchlist";
import { saveActiveVoting, removeActiveVoting, getActiveVotings } from "./votings";

const dbApi = {
    initDb,
    migrateFromJson,
    saveActiveVoting,
    removeActiveVoting,
    getActiveVotings,
    registerMovieStart,
    addVote,
    getMovieRatings,
    getAllMoviesWithRatings,
    addToWatchlist,
    getWatchlist,
    removeFromWatchlist,
    removeFromWatchlistByTitle,
    deleteMovie,
    isMovieWatched,
};

export default dbApi;
