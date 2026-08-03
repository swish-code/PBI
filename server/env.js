// Loads server/.env.local (wins) then server/.env, BEFORE any module reads process.env.
// Import this FIRST in every entrypoint (server.js / worker.js / web.js) and in
// pbi-core.js — ES module imports evaluate in order, so this guarantees env is
// populated before token/model/config code runs. Idempotent (dotenv won't override).
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env.local") });
dotenv.config({ path: path.join(__dirname, ".env") });
