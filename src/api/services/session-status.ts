import type { RoomManager } from "../../core/room-manager";
import type { SessionRating } from "../../shared/types";

interface SessionViewer {
  discordId: string;
  username: string;
}

export interface SessionStatusData {
  status: "waiting" | "playing" | "ended";
  viewerCount: number;
  viewers: SessionViewer[];
  ratings: SessionRating[];
  average: number;
  allRated: boolean;
  movieInfo: unknown | null;
  movieName: string;
}

export function buildSessionStatusData(
  roomManager: typeof RoomManager.prototype,
  roomId: string
): SessionStatusData | null {
  const room = roomManager.getRoom(roomId);
  if (!room) return null;

  const connectedUsers = roomManager.getConnectedUsers(roomId);
  const { ratings, average } = roomManager.getRatings(roomId);

  return {
    status: room.status,
    viewerCount: connectedUsers.length,
    viewers: connectedUsers.map((user) => ({
      discordId: user.discordId,
      username: user.username,
    })),
    ratings,
    average,
    allRated: roomManager.allUsersRated(roomId),
    movieInfo: room.movieInfo || null,
    movieName: room.movieName || "Filme",
  };
}
