// Credentials live in the repo's .env (gitignored), shared with the Python backend.
import path from "node:path";

const ROOT_ENV = path.resolve(import.meta.dirname, "..", "..", ".env");
try {
  process.loadEnvFile(ROOT_ENV);
} catch {
  // No .env (e.g. CI): fall back to the process environment.
}

export function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set (expected in ${ROOT_ENV})`);
  return value;
}

export function optionalEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}
