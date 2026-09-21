import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileDiff } from "@agent-rooms/protocol";
import type { AgentView } from "@agent-rooms/view";
import { lineAt } from "@agent-rooms/view";
import {
  createCheckpoint,
  fetchDiffFrom,
  listCheckpoints,
  reopenComment,
  resolveComment,
  submitReview,
  type CheckpointRow,
  type DraftComment,
} from "../lib/api.js";
import { loadDrafts, newDraftId, saveDrafts, type Draft } from "../lib/drafts.js";
import { CheckpointPicker } from "./CheckpointPicker.js";
import { DiffFile, type Composing } from "./DiffFile.js";
import { ReviewTray } from "./ReviewTray.js";

/**
 * Diff sekmesi.
 *
 * CANLI GÜNCELLEME KAYDIRMA KONUMUNU BOZMAZ. Yeni bir `diff.updated` geldiğinde
 * liste yerinde kalır; üstte "N dosya güncellendi" hapı çıkar ve tıklanınca o
 * dosyaya gidilir. Listeyi kendiliğinden kaydırmak, okuduğun satırı elinden
 * almak demektir.
 */

export function DiffView({
  roomId,
  agent,
  agentView,
  canWrite,
  agentStatus,
  /** Etkinlik akışından "bu dosyaya git" isteği. */
  focusPath,
  onFocusHandled,
}: {
  roomId: string;
  agent: string;
  agentView: AgentView | undefined;
  canWrite: boolean;
  agentStatus: string;
  focusPath: string | null;
  onFocusHandled: () => void;
}) {
  const live = agentView?.diff ?? { base: null, files: {}, lastSeq: 0 };
  const comments = agentView?.comments ?? [];

  const [drafts, setDrafts] = useState<Draft[]>(() => loadDrafts(roomId, agent));
  const [composing, setComposing] = useState<Composing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<number | null>(null);

  const [checkpoints, setCheckpoints] = useState<CheckpointRow[]>([]);
  const [cpError, setCpError] = useState<string | null>(null);
  /** null = canlı taban; aksi hâlde isteğe bağlı (CANLI OLMAYAN) diff. */
  const [compareFrom, setCompareFrom] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<{ files: FileDiff[] } | null>(null);

  /** Kullanıcının GÖRDÜĞÜ son seq — hap bunun üstündeki dosyaları sayıyor. */
  const [seenSeq, setSeenSeq] = useState(live.lastSeq);
  const scroller = useRef<HTMLDivElement | null>(null);

  // Agent değişince taslaklar da değişir: anahtar oda + agent.
  useEffect(() => {
    setDrafts(loadDrafts(roomId, agent));
    setComposing(null);
    setCompareFrom(null);
    setSnapshot(null);
    setPosition(null);
    setSeenSeq(0);
  }, [roomId, agent]);

  useEffect(() => saveDrafts(roomId, agent, drafts), [roomId, agent, drafts]);

  const loadCheckpoints = useCallback(() => {
    void listCheckpoints(roomId, agent)
      .then(setCheckpoints)
      .catch(() => undefined);
  }, [roomId, agent]);

  // Checkpoint listesi event'lerden de türeyebilirdi; ama ucu çağırmak
  // `createdBy` gibi projeksiyonda tutulmayan alanları da getiriyor.
  useEffect(() => {
    loadCheckpoints();
  }, [loadCheckpoints, agentView?.checkpoints.length]);

  const liveFiles = useMemo(
    () => Object.values(live.files).sort((a, b) => (a.path < b.path ? -1 : 1)),
    [live.files],
  );

  const shown: Array<FileDiff & { seq?: number }> =
    compareFrom === null ? liveFiles : (snapshot?.files ?? []);

  /** Son görülenden yeni olan dosyalar — hap ve başlık vurgusu bunları sayar. */
  const updated = compareFrom === null ? liveFiles.filter((f) => (f.seq ?? 0) > seenSeq) : [];

  const openComments = comments.filter((c) => !c.resolved);

  /** Taslağın çapası hâlâ tutuyor mu: canlı patch'teki satır metniyle karşılaştır. */
  const isDraftStale = useCallback(
    (d: Draft): boolean => {
      const file = live.files[d.path];
      if (!file) return true;
      return lineAt(file.patch, d.side, d.line) !== d.lineText;
    },
    [live.files],
  );

  const staleCount = drafts.filter(isDraftStale).length;

  const goToFile = useCallback((path: string) => {
    const el = scroller.current?.querySelector(`[data-diff-file="${CSS.escape(path)}"]`);
    if (!el) return;
    el.dispatchEvent(new CustomEvent("rooms:open-file"));
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Etkinlik akışındaki bir dosyaya tıklanınca buraya gelinir.
  useEffect(() => {
    if (!focusPath) return;
    goToFile(focusPath);
    onFocusHandled();
  }, [focusPath, goToFile, onFocusHandled]);

  const send = async (comments: DraftComment[]): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await submitReview(roomId, agent, comments);
      setPosition(res.position);
      // Taslakları ancak SUNUCU kabul ettikten sonra temizle: hata olursa
      // yazılmış metin elde kalsın.
      setDrafts([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleResolved = async (commentId: string, resolved: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // Ekran ELLE güncellenmez: `comment.resolved` SSE'den gelince değişir.
      await (resolved ? resolveComment(roomId, commentId) : reopenComment(roomId, commentId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const takeCheckpoint = async (label: string): Promise<void> => {
    setBusy(true);
    setCpError(null);
    try {
      await createCheckpoint(roomId, agent, label);
      setSeenSeq(0);
      loadCheckpoints();
    } catch (err) {
      setCpError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const loadSnapshot = useCallback(
    (from: string) => {
      setBusy(true);
      setCpError(null);
      void fetchDiffFrom(roomId, agent, from)
        .then((r) => setSnapshot({ files: r.files }))
        .catch((err: Error) => setCpError(err.message))
        .finally(() => setBusy(false));
    },
    [roomId, agent],
  );

  useEffect(() => {
    if (compareFrom === null) setSnapshot(null);
    else loadSnapshot(compareFrom);
  }, [compareFrom, loadSnapshot]);

  const blockedReason =
    agentStatus === "busy"
      ? "agent çalışıyor — checkpoint için boşta olmalı"
      : agentStatus === "starting"
        ? "agent başlıyor"
        : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <CheckpointPicker
        checkpoints={checkpoints}
        selected={compareFrom}
        onSelect={setCompareFrom}
        onRefresh={() => compareFrom && loadSnapshot(compareFrom)}
        canCheckpoint={canWrite}
        blockedReason={blockedReason}
        onCheckpoint={(label) => void takeCheckpoint(label)}
        busy={busy}
        error={cpError}
      />

      {/* Kaydırma konumu SABİT kalır; değişiklik bir hap olarak duyurulur. */}
      {updated.length > 0 && (
        <button
          onClick={() => {
            const first = updated[0];
            if (first) goToFile(first.path);
            setSeenSeq(live.lastSeq);
          }}
          style={{
            alignSelf: "center",
            margin: "6px 0 0",
            borderColor: "var(--ink-soft)",
            background: "#fff",
          }}
        >
          {updated.length} dosya güncellendi — göster
        </button>
      )}

      <div ref={scroller} style={{ flex: 1, overflow: "auto", minHeight: 0, padding: 10 }}>
        {live.base === null && compareFrom === null && (
          <div style={{ color: "var(--ink-soft)" }}>
            Bu agent'ın diff tabanı henüz yok. Taban, agent ilk başlatıldığında alınıyor.
          </div>
        )}

        {live.base !== null && shown.length === 0 && (
          <div style={{ color: "var(--ink-soft)" }}>
            {compareFrom === null
              ? `Tabana göre değişiklik yok (${live.base.label}).`
              : "Seçilen checkpoint'e göre değişiklik yok."}
          </div>
        )}

        {shown.map((f) => (
          <DiffFile
            key={f.path}
            file={f}
            comments={compareFrom === null ? comments.filter((c) => c.path === f.path) : []}
            drafts={compareFrom === null ? drafts.filter((d) => d.path === f.path) : []}
            /* CANLI OLMAYAN görünümde yorum bırakılmaz: sunucu çapayı canlı
               diff'e göre doğruluyor, bayat bir satıra yazılan yorum reddedilirdi. */
            canComment={canWrite && compareFrom === null}
            canResolve={canWrite && compareFrom === null}
            highlighted={(f.seq ?? 0) > seenSeq}
            diffSeq={live.lastSeq}
            composing={composing}
            onCompose={setComposing}
            onComposeBody={(body) => setComposing((c) => (c ? { ...c, body } : c))}
            isDraftStale={isDraftStale}
            onAddDraft={(d) => setDrafts((prev) => [...prev, { ...d, id: newDraftId() }])}
            onSendNow={(d) => void send([d])}
            onRemoveDraft={(id) => setDrafts((prev) => prev.filter((x) => x.id !== id))}
            onToggleResolved={(id, r) => void toggleResolved(id, r)}
            busy={busy}
          />
        ))}

        {openComments.length > 0 && compareFrom === null && (
          <div style={{ color: "var(--ink-soft)", fontSize: 12, marginTop: 8 }}>
            {openComments.length} açık yorum · {comments.length - openComments.length} çözüldü
          </div>
        )}
      </div>

      <ReviewTray
        drafts={drafts}
        staleCount={staleCount}
        position={position}
        busy={busy}
        error={error}
        onSubmit={() => void send(drafts.map(({ id: _id, ...rest }) => rest))}
        onClear={() => setDrafts([])}
      />
    </div>
  );
}
