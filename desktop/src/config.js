// What the app remembers between runs, in its own folder (~/Library/Application Support/Emplio on a Mac).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function loadConfig(file, vault) {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  const config = { enabled: true, ...saved, installId: saved.installId ?? randomUUID() };
  // the token is kept encrypted with the system's keychain when there is one
  const token = saved.token ? (saved.sealed ? vault.open(saved.token) : saved.token) : null;
  const save = () => {
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    const sealed = config.token ? vault.seal(config.token) : null;
    writeFileSync(file, JSON.stringify({ ...config, token: sealed ?? config.token, sealed: !!sealed }, null, 2), { mode: 0o600 });
  };
  config.token = token;
  save();
  return Object.assign(config, { save });
}
