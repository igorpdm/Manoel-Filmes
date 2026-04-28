import { Database } from "bun:sqlite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_FILE = join(__dirname, "..", "movies.db");

let instance: Database | undefined;

export const getDb = (): Database => {
    if (!instance) {
        instance = new Database(DB_FILE, { create: true });
        instance.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
        `);
    }
    return instance;
};
