import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { RoomConfig } from "@agent-rooms/protocol";

export interface LoadedRoomConfig {
  config: RoomConfig;
  /** Ham YAML'ın sha256'sı — `room.created` event'ine yazılır. */
  digest: string;
  sourcePath: string;
}

export class RoomConfigError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "RoomConfigError";
  }
}

/** YAML metnini doğrular. Dosya okumadan test edilebilsin diye ayrı. */
export function parseRoomConfig(yamlText: string, sourcePath = "<inline>"): LoadedRoomConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new RoomConfigError(`${sourcePath}: YAML ayrıştırılamadı`, [String(err)]);
  }

  const result = RoomConfig.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "<kök>"}: ${i.message}`);
    throw new RoomConfigError(`${sourcePath}: rol konfigürasyonu geçersiz`, issues);
  }

  return {
    config: result.data,
    digest: createHash("sha256").update(yamlText).digest("hex"),
    sourcePath,
  };
}

export async function loadRoomConfig(path: string): Promise<LoadedRoomConfig> {
  const text = await readFile(path, "utf8");
  return parseRoomConfig(text, path);
}

/** Agent'ı adıyla bul. Kod hiçbir yerde indeks varsaymaz. */
export function findAgent(config: RoomConfig, name: string) {
  return config.agents.find((a) => a.name === name) ?? null;
}
