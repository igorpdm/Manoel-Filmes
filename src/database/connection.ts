import Database from "better-sqlite3";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_FILE = join(__dirname, "..", "movies.db");

let instance: Database.Database | undefined;

export const getDb = (): Database.Database => {
    if (!instance) {
        instance = new Database(DB_FILE);
        instance.pragma("journal_mode = WAL");
    }
    return instance;
};
