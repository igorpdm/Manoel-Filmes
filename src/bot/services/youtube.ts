import { Innertube } from "youtubei.js";
import { logger } from "../../shared/logger";

let youtubeClientPromise: Promise<Innertube> | null = null;

function getYoutubeClient(): Promise<Innertube> {
  if (!youtubeClientPromise) {
    youtubeClientPromise = Innertube.create({
      lang: "pt",
      location: "BR",
      retrieve_player: false,
    }).catch((error) => {
      youtubeClientPromise = null;
      throw error;
    });
  }

  return youtubeClientPromise;
}

function getVideoId(video: unknown): string | null {
  if (!video || typeof video !== "object") {
    return null;
  }

  const videoId = (video as { video_id?: unknown }).video_id;
  return typeof videoId === "string" && videoId.trim() ? videoId : null;
}

export const searchTrailerYoutube = async (movieTitle: string, year = ""): Promise<string | null> => {
  const query = `trailer ${movieTitle} ${year} official`.trim();

  try {
    const youtube = await getYoutubeClient();
    const result = await youtube.search(query, { type: "video" });
    const video = result.videos.find((item) => getVideoId(item));
    const videoId = getVideoId(video);

    return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
  } catch (error) {
    logger.error("YoutubeService", `Falha ao buscar trailer: ${query}`, error);
    return null;
  }
};
