import { useState } from "react";
import type { CheckpointRow } from "../lib/api.js";

/**
 * "Karşılaştırma: …" çubuğu.
 *
 * CANLI TABAN DIŞINDAKİ HER SEÇİM CANLI DEĞİLDİR ve bu ekranda yazar. Bayat
 * bir diff'i canlı sanmak, üzerine yorum yazılan bir yalandır — o yüzden
 * uyarı bir ipucu değil, çubuğun kendisi.
 */

const kindLabel = (cp: CheckpointRow): string => {
  if (cp.kind === "baseline") return "taban (oturumun başı)";
  if (cp.kind === "manual") return `elle: ${cp.label}`;
  return cp.label;
};

export function CheckpointPicker({
  checkpoints,
  selected,
  onSelect,
  onRefresh,
  canCheckpoint,
  /** Agent boşta değilse checkpoint alınamaz — sebebi yazılır. */
  blockedReason,
  onCheckpoint,
  busy,
  error,
}: {
  checkpoints: CheckpointRow[];
  /** null = canlı taban. */
  selected: string | null;
  onSelect: (checkpointId: string | null) => void;
  onRefresh: () => void;
  canCheckpoint: boolean;
  blockedReason: string | null;
  onCheckpoint: (label: string) => void;
  busy: boolean;
  error: string | null;
}) {
  const [label, setLabel] = useState("");
  const [asking, setAsking] = useState(false);

  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        flexWrap: "wrap",
        padding: "6px 10px",
        borderBottom: "1px solid var(--rule)",
        background: "var(--paper)",
      }}
    >
      <label style={{ color: "var(--ink-soft)", fontSize: 12 }}>
        Karşılaştırma:{" "}
        <select
          value={selected ?? ""}
          onChange={(e) => onSelect(e.target.value === "" ? null : e.target.value)}
        >
          <option value="">canlı taban</option>
          {checkpoints.map((cp) => (
            <option key={cp.checkpointId} value={cp.checkpointId}>
              {kindLabel(cp)} · {new Date(cp.createdAt).toLocaleTimeString("tr-TR")}
            </option>
          ))}
        </select>
      </label>

      {selected !== null && (
        <span style={{ color: "var(--wait)", fontSize: 12 }}>
          Bu görünüm canlı değil —{" "}
          <button onClick={onRefresh} disabled={busy}>
            yenile
          </button>
        </span>
      )}

      <span style={{ marginLeft: "auto" }} />

      {canCheckpoint &&
        (asking ? (
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="öğle arası"
              style={{ font: "inherit", padding: "3px 6px", border: "1px solid var(--rule)" }}
            />
            <button
              disabled={busy || label.trim().length === 0}
              onClick={() => {
                onCheckpoint(label.trim());
                setLabel("");
                setAsking(false);
              }}
            >
              Al
            </button>
            <button onClick={() => setAsking(false)}>Vazgeç</button>
          </span>
        ) : (
          <button
            disabled={busy || blockedReason !== null}
            title={blockedReason ?? "Şu anki hâli yeni taban yap"}
            onClick={() => setAsking(true)}
          >
            Checkpoint al
          </button>
        ))}

      {/* Düğmenin neden kapalı olduğu YAZAR: kapalı bir düğme tek başına
          "bozuk mu?" sorusu doğurur. */}
      {canCheckpoint && blockedReason && (
        <span style={{ color: "var(--ink-soft)", fontSize: 11 }}>{blockedReason}</span>
      )}
      {error && <span style={{ color: "var(--fail)", fontSize: 12 }}>{error}</span>}
    </div>
  );
}
