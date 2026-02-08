import yts from "yt-search";

export const searchTrailerYoutube = async (movieTitle: string, year = "") => {
  const query = `trailer ${movieTitle} ${year} official`.trim();
  try {
    const result = await yts(query);
    const video = result?.videos?.[0];
    return video?.url || null;
  } catch {
    return null;
  }
};