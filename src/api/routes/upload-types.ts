import type { RoomManager } from "../../core/room-manager";

export interface UploadDeps {
  roomManager: typeof RoomManager.prototype;
  uploadsDir: string;
}

export interface UploadMeta {
  roomId: string;
  uploadId: string;
  filename: string;
  totalChunks: number;
  chunkSize: number;
  totalSize: number;
  receivedChunks: number[];
  createdAt: number;
  lastActivity: number;
}
