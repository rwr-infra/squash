// Loads a .env file (from the working directory) into process.env, if present.
//
// IMPORTANT: this must run BEFORE any module that reads process.env at the top
// level (e.g. api/http/auth.ts). Import this module FIRST in src/index.ts so its
// side effect executes ahead of the others.
//
// Uses Node's built-in env-file loader (Node >= 20.12) — no dotenv dependency.
try {
  process.loadEnvFile();
} catch {
  // No .env file present — fall back to the real process environment.
}
