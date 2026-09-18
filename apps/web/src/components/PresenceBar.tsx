import type { Person } from "../lib/api.js";

/**
 * Odadaki kişiler.
 *
 * Renk tek başına bilgi taşımaz: baş harflerin yanında tam isim tooltip'te
 * yazar, kimin nereye baktığı agent satırında ayrıca işaretlenir.
 */

const initials = (name: string): string =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";

/** İsimden sabit bir ton — aynı kişi her zaman aynı renkte görünsün. */
function tone(userId: string): string {
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hash} 32% 42%)`;
}

export function PresenceBar({ people, meId }: { people: Person[]; meId: string | null }) {
  if (people.length === 0) return null;

  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }} aria-label="odadakiler">
      {people.map((p) => (
        <span
          key={p.userId}
          title={`${p.name}${p.userId === meId ? " (sen)" : ""}${
            p.viewing ? ` · ${p.viewing} agent'ına bakıyor` : ""
          }`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            borderRadius: "50%",
            background: tone(p.userId),
            color: "#fff",
            fontSize: 11,
            fontWeight: 600,
            border: p.userId === meId ? "2px solid var(--ink)" : "2px solid transparent",
          }}
        >
          {initials(p.name)}
        </span>
      ))}
      <span style={{ color: "var(--ink-soft)", fontSize: 12, marginLeft: 2 }}>
        {people.length} kişi
      </span>
    </div>
  );
}
