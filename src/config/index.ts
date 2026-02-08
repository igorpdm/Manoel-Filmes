import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from root
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

export const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
export const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
export const TMDB_API_KEY = process.env.TMDB_API_KEY;
export const TMDB_BASE_URL = "https://api.themoviedb.org/3";
export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500";
export const ADMIN_USER_ID = process.env.ADMIN_USER_ID || "";

// Server Configuration
export const PORT = process.env.PORT || 3000;
export const IS_PROD = process.env.NODE_ENV === "production";

// Paths
export const ROOT_DIR = path.resolve(__dirname, "..", "..");
export const PUBLIC_DIR = path.join(ROOT_DIR, "public");
export const UPLOADS_DIR = path.join(ROOT_DIR, "uploads");