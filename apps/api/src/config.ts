import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Sunucu ayarları. Hepsi .env'den okunur, hepsinin makul varsayılanı var —
 * `npm run api` tek başına çalışsın.
 */

// dist/config.js → apps/api/dist → apps/api → apps → repo kökü
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = process.env.REPO_ROOT
  ? path.resolve(process.env.REPO_ROOT)
  : path.resolve(here, "../../..");

export interface ApiConfig {
  port: number;
  /** Oda klasörlerinin kökü. Oda başına <roomsDataDir>/<roomId> açılır. */
  roomsDataDir: string;
  roomImage: string;
  /** Varsayılan rol YAML'ı. İstek gövdesinde configPath ile ezilebilir. */
  defaultConfigPath: string;
  /** false: container açılmaz. Docker'sız geliştirme için. */
  spawnContainer: boolean;
  agent: AgentSettings;
}

export interface AgentSettings {
  /** Claude koşum ortamı için. Anahtar imaja veya compose'a gömülmez. */
  apiKey: string;
  /** Gemini koşum ortamı için. Claude'unkinden bağımsız. */
  geminiApiKey: string;
  /** YAML'daki model'i ezer. Kapı testleri maliyeti düşürmek için haiku verir. */
  modelOverride: string;
  maxTurns: number;
  maxBudgetUsd: number;
  heartbeatTimeoutMs: number;
}

export function loadApiConfig(): ApiConfig {
  return {
    port: Number(process.env.PORT ?? 8787),
    roomsDataDir: path.resolve(REPO_ROOT, process.env.ROOM_DATA_DIR ?? "./rooms-data"),
    roomImage: process.env.ROOM_IMAGE ?? "agent-rooms/room:dev",
    defaultConfigPath: path.resolve(
      REPO_ROOT,
      process.env.ROOM_CONFIG ?? "./config/room.example.yaml",
    ),
    spawnContainer: process.env.SPAWN_CONTAINER !== "0",
    agent: {
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
      geminiApiKey: process.env.GEMINI_API_KEY ?? "",
      modelOverride: process.env.AGENT_MODEL ?? "",
      maxTurns: Number(process.env.AGENT_MAX_TURNS ?? 30),
      maxBudgetUsd: Number(process.env.AGENT_MAX_BUDGET_USD ?? 1),
      heartbeatTimeoutMs: Number(process.env.AGENT_HEARTBEAT_TIMEOUT_MS ?? 20_000),
    },
  };
}

/** İstek gövdesindeki yol repo kökünün dışına çıkamaz. */
export function resolveConfigPath(cfg: ApiConfig, given?: string): string {
  if (!given) return cfg.defaultConfigPath;
  const resolved = path.resolve(REPO_ROOT, given);
  if (resolved !== REPO_ROOT && !resolved.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(`konfigürasyon yolu repo kökünün dışında: ${given}`);
  }
  return resolved;
}
