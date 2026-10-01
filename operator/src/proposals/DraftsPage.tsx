import { useEffect, useState } from "react";
import { api, errorText, type DraftSummary } from "../api";
import { linkHandler } from "../router";
import { Icon, Kip, timeAgo } from "../ui";
import { ParksTabs } from "./ParksTabs";

function Check({ done, label }: { done: boolean; label: string }) {
  return <span className={`check${done ? " is-done" : ""}`}><Icon name={done ? "check" : "plus"} size={13} /> {label}</span>;
}

export function DraftsPage() {
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<{ drafts: DraftSummary[] }>("/api/drafts", { signal: controller.signal })
      .then((result) => setDrafts(result.drafts))
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorText(reason, "Could not load drafts.")); });
    return () => controller.abort();
  }, [revision]);

  const open = drafts?.filter((draft) => draft.status === "draft") ?? [];
  const published = drafts?.filter((draft) => draft.status === "published") ?? [];

  return (
    <section className="page" aria-labelledby="drafts-title">
      <ParksTabs current="/proposals/drafts" />
      <header className="page-head">
        <div>
          <p className="eyebrow">Not on phones yet</p>
          <h1 id="drafts-title">Park drafts</h1>
          <p className="page-lede">Set a rarity, then add a name, description and badge. A draft reaches the app only when you publish it.</p>
        </div>
        <div className="toolbar">
          <a className="button button--primary" href="/proposals/import" onClick={linkHandler("/proposals/import")}><Icon name="plus" size={16} /> Import a park</a>
        </div>
      </header>
      {error && <div className="notice notice--error" role="alert"><Icon name="alert" /> {error} <button type="button" className="text-button" onClick={() => setRevision((value) => value + 1)}>Try again</button></div>}
      {drafts && drafts.length === 0 && (
        <div className="empty"><Kip pose="map" size={96} /><h2>No drafts yet</h2><p className="muted">Import a park from the legacy map to start one.</p></div>
      )}
      {open.length > 0 && (
        <div className="draft-grid">
          {open.map((draft) => (
            <a key={draft.id} className="draft-card" href={`/proposals/drafts/${draft.id}`} onClick={linkHandler(`/proposals/drafts/${encodeURIComponent(draft.id)}`)}>
              <div className="draft-card__top">
                <strong>{draft.name}</strong>
                {draft.rarity && <span className={`rarity rarity--${draft.rarity}`}>{draft.rarity}</span>}
              </div>
              <span className="muted draft-card__id">{draft.id}</span>
              <span className="draft-card__checks">
                <Check done={Boolean(draft.category)} label="Category" />
                <Check done={Boolean(draft.rarity)} label="Rarity" />
                <Check done={draft.hasBlurb} label="Description" />
                <Check done={draft.hasBadge} label="Badge" />
              </span>
              <span className="muted draft-card__time">Edited {timeAgo(draft.updatedAt)}</span>
            </a>
          ))}
        </div>
      )}
      {published.length > 0 && (
        <>
          <h2 className="build-group__title published-title">Published</h2>
          <div className="draft-grid">
            {published.map((draft) => (
              <a key={draft.id} className="draft-card draft-card--published" href={`/proposals/drafts/${draft.id}`} onClick={linkHandler(`/proposals/drafts/${encodeURIComponent(draft.id)}`)}>
                <div className="draft-card__top"><strong>{draft.name}</strong><span className="status-chip status-chip--in-parkdex">Live</span></div>
                <span className="muted draft-card__id">{draft.id}</span>
              </a>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
