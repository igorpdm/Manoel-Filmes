import { existsSync, readdirSync } from "fs";
import { basename, join } from "path";
import sanitizeFilename from "sanitize-filename";

export function getSubtitlesDir(uploadsDir: string, roomId: string): string {
  return join(uploadsDir, `${roomId}_subtitles`);
}

export function decodeSubtitleBuffer(buffer: Buffer): string {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf-8");
  }

  const utf8 = buffer.toString("utf-8");
  if (!utf8.includes("\ufffd")) return utf8;

  const decoder = new TextDecoder("windows-1252");
  return decoder.decode(buffer);
}

export function listRoomUploadDirs(uploadsDir: string, roomId: string): string[] {
  if (!existsSync(uploadsDir)) return [];
  const entries = readdirSync(uploadsDir, { withFileTypes: true });
  const prefix = `${roomId}_`;
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => join(uploadsDir, entry.name));
}

export function getPartPath(chunksDir: string): string {
  return join(chunksDir, "upload.part");
}

export function sanitizeUploadFilename(name: string): string {
  const normalizedName = basename(name).trim();
  const safeName = sanitizeFilename(normalizedName);
  return safeName || "upload.bin";
}
