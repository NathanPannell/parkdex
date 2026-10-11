import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorText } from "../api";
import { linkHandler } from "../router";
import { formatCount, fullDate, Icon, Notice, PageHeader, Spinner, Tabs, timeAgo, useConfirm, useToast, EmptyState } from "../ui";
import { ParkMap } from "./ParkMap";
import { notifyReviewsChanged, useReviewCount } from "./reviewCount";
import { FLAG_LABELS, REVIEW_REASONS, title, type Position, type ReviewDetail, type ReviewItem, type ReviewList, type ReviewReasonCode, type ReviewStatus } from "./types";

/**
 * /parks/review: players' requests for a manual review of a founding photo the check turned
 * down (#153). Oldest first. Approving founds the park with the photo as its cover and pays the
 * founder bonus, without a visit or a flag; rejecting sends the player a short reason.
 */

const STATUSES: Array<{ id: ReviewStatus | "all"; label: string }> = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "superseded", label: "Superseded" },
  { id: "all", label: "All" },
];

/** The Catalogue and Review tabs at the top of both Parks pages. */
export function ParksTabs({ current }: { current: "/parks" | "/parks/review" }) {
  const pending = useReviewCount();
  return (
    <Tabs label="Parks pages" value={current} items={[
      { id: "/parks", label: "Catalogue", icon: "park", href: "/parks" },
      { id: "/parks/review", label: "Review", icon: "check", href: "/parks/review", count: pending || undefined },
    ]} />
  );
}

function readParams(): { status: ReviewStatus | "all"; id: string | null } {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("status");
  return { status: STATUSES.some((item) => item.id === status) ? status as ReviewStatus | "all" : "pending", id: params.get("id") };
}

function writeParams(status: string, id: string | null) {
  const params = new URLSearchParams();
  if (status !== "pending") params.set("status", status);
  if (id) params.set("id", id);
  const query = params.toString();
  window.history.replaceState(null, "", `/parks/review${query ? `?${query}` : ""}`);
}

/** A ring around the player's position as wide as the reported accuracy, drawn as the map's sketch. */
function accuracyRing(lng: number, lat: number, radiusM: number, sides = 48): Position[] {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180), ky = 110_540;
  return Array.from({ length: sides }, (_, index) => {
    const angle = (index / sides) * Math.PI * 2;
    return [lng + (Math.cos(angle) * radiusM) / kx, lat + (Math.sin(angle) * radiusM) / ky] as Position;
  });
}

function outcomeLabel(item: Pick<ReviewItem, "outcome" | "flags">): string {
  if (item.outcome === "unsure") return "Unsure";
  return item.flags.map((flag) => FLAG_LABELS[flag] ?? title(flag)).join(", ") || "Rejected";
}

function bytes(value: number | null): string {
  if (value === null) return "removed";
  return value >= 1_048_576 ? `${(value / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`;
}

function percent(value: number | undefined): string {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "–";
}

function Row({ item, active, onOpen }: { item: ReviewItem; active: boolean; onOpen(): void }) {
  return (
    <button type="button" className={`rv-row${active ? " is-active" : ""}`} onClick={onOpen} aria-current={active ? "true" : undefined}>
      {item.hasPhoto
        ? <img className="rv-thumb" src={`/api/parks/review/${item.id}/photo`} alt="" loading="lazy" width={64} height={48} />
        : <span className="rv-thumb rv-thumb--gone"><Icon name="image" size={18} /></span>}
      <span className="rv-row__main">
        <strong>{item.parkName}</strong>
        <span>@{item.handle ?? "deleted account"} · {timeAgo(item.createdAt)}</span>
      </span>
      {item.status === "pending"
        ? <span className={`rv-chip rv-chip--${item.outcome}`}>{outcomeLabel(item)}</span>
        : <span className={`rv-chip rv-chip--${item.status}`}>{title(item.status)}</span>}
    </button>
  );
}

/**
 * The model's answer to each flag, marked at the threshold it is judged against. Checks stored
 * before the verdict question was dropped also show the verdict's approve probability.
 */
function CheckAnswers({ detail }: { detail: ReviewDetail }) {
  const moderation = detail.moderation;
  const answers = moderation?.answers ?? {};
  const verdict = answers.verdict?.probabilities;
  // Older checks counted every flag above one half.
  const limit = (flag: string) => moderation?.flagThresholds?.[flag] ?? 0.5;
  const flags = Object.keys(FLAG_LABELS);
  return (
    <section className="rv-check" aria-labelledby="rv-check-title">
      <h3 id="rv-check-title">Photo check</h3>
      <p className="rv-check__verdict">
        <span className={`rv-chip rv-chip--${detail.outcome}`}>{detail.outcome === "unsure" ? "Unsure" : "Rejected"}</span>
        {detail.outcome === "reject" ? ` for ${outcomeLabel(detail).toLowerCase()}` : " The check could not decide."}
      </p>
      <div className="rv-bars">
        {verdict ? (
          <div className="rv-bar rv-bar--verdict">
            <span>Approve</span>
            <span className="rv-bar__track"><span style={{ width: percent(verdict.approve) }} /></span>
            <strong>{percent(verdict.approve)}</strong>
          </div>
        ) : null}
        {flags.map((flag) => {
          const yes = answers[flag]?.probabilities?.yes;
          return (
            <div key={flag} className={`rv-bar${typeof yes === "number" && yes > limit(flag) ? " is-flagged" : ""}`} title={`Counts above ${percent(limit(flag))}`}>
              <span>{FLAG_LABELS[flag]}</span>
              <span className="rv-bar__track"><span style={{ width: percent(yes) }} /><i className="rv-bar__tick" style={{ left: percent(limit(flag)) }} /></span>
              <strong>{percent(yes)}</strong>
            </div>
          );
        })}
      </div>
      <p className="muted rv-check__model">
        {!moderation ? "No answers were stored for this check."
          : verdict ? <>{moderation.model ?? "Unknown model"} · approves at {percent(moderation.threshold ?? undefined)} and no flag above 50%</>
          : <>{moderation.model ?? "Unknown model"} · approves when no flag is above its mark</>}
      </p>
    </section>
  );
}

function Decision({ detail }: { detail: ReviewDetail }) {
  if (detail.status === "approved") {
    const parkId = detail.foundedParkId ?? detail.parkId;
    return (
      <div className="rv-decided rv-decided--approved">
        <Icon name="check" size={20} />
        <p>Approved {detail.decidedAt ? timeAgo(detail.decidedAt) : ""}. <strong>@{detail.handle ?? "deleted account"}</strong> founded{" "}
          <a href={`/parks/${parkId}`} onClick={linkHandler(`/parks/${parkId}`)}>{detail.parkName}</a> with this photo as its cover.
          {detail.seenAt ? " The player has seen it." : " The player sees it the next time they open the app."}</p>
      </div>
    );
  }
  if (detail.status === "rejected") {
    return (
      <div className="rv-decided rv-decided--rejected">
        <Icon name="close" size={20} />
        <p>Rejected {detail.decidedAt ? timeAgo(detail.decidedAt) : ""}. The player reads: <q>{detail.reason}</q>{detail.seenAt ? " (seen)" : ""}</p>
      </div>
    );
  }
  return (
    <div className="rv-decided">
      <Icon name="flag" size={20} />
      <p>Superseded {detail.decidedAt ? timeAgo(detail.decidedAt) : ""}: {detail.park.founder ? <>@{detail.park.founder.handle ?? "deleted account"} founded it first.</> : "the park was founded another way first."}</p>
    </div>
  );
}

function Detail({ id, onDecided }: { id: string; onDecided(next: { decidedId: string }): void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [reasonCode, setReasonCode] = useState<ReviewReasonCode | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setError("");
    try {
      const loaded = await api<{ request: ReviewDetail }>(`/api/parks/review/${id}`, { signal });
      setDetail(loaded.request);
    } catch (reason) {
      if (!signal?.aborted) setError(errorText(reason, "Could not load this request."));
    }
  }, [id]);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setReasonCode(null);
    setReason("");
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (error) return <div className="rv-detail"><Notice tone="error">{error}</Notice></div>;
  if (!detail) return <div className="rv-detail rv-detail--loading"><Spinner /> Opening request...</div>;

  const pending = detail.status === "pending";
  const newPark = Boolean(detail.osm) && !detail.park.inParkdex;
  const blocked = detail.park.founder ? `@${detail.park.founder.handle ?? "deleted account"} founded this park ${timeAgo(detail.park.founder.foundedAt)}.` : detail.park.hidden ? "This park is hidden." : null;
  const photoUrl = `/api/parks/review/${detail.id}/photo`;
  const pin: Position = [detail.position.lng, detail.position.lat];
  const ring = accuracyRing(detail.position.lng, detail.position.lat, Math.max(detail.position.accuracyM, 3));
  const typedReason = reason.trim();
  const canReject = reasonCode !== null && (reasonCode !== "other" || typedReason.length > 0) && typedReason.length <= 300;

  async function decide(kind: "approve" | "reject", run: () => Promise<unknown>, done: string) {
    setBusy(kind);
    try {
      await run();
      toast.show(done);
      notifyReviewsChanged();
      onDecided({ decidedId: id });
    } catch (reason) {
      toast.show(errorText(reason, "That did not work. Nothing was changed."), { tone: "error" });
      await load();
      notifyReviewsChanged();
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    if (!detail) return;
    const confirmed = await confirm({
      title: `Approve and found ${detail.parkName}?`,
      icon: "check",
      confirmLabel: "Approve and found",
      body: (
        <>
          <p><strong>@{detail.handle ?? "deleted account"}</strong> becomes the founder, this photo becomes the public cover, and they earn the 10 founder points.</p>
          <ul>
            {newPark && <li>The OpenStreetMap outline is published as a new Parkdex park in the same change, so every player's app gets it on its next sync.</li>}
            <li>No flag is planted and no visit is recorded. Flags still need a real visit.</li>
            {detail.otherPending > 0 && <li>{detail.otherPending} other pending {detail.otherPending === 1 ? "request" : "requests"} for this park close as superseded.</li>}
            <li>The player sees "You're the founder of {detail.parkName}" the next time they open the app.</li>
          </ul>
        </>
      ),
    });
    if (!confirmed) return;
    await decide("approve", () => api(`/api/parks/review/${detail.id}/approve`, { method: "POST" }), `${detail.parkName} was founded by @${detail.handle ?? "the player"}`);
  }

  async function reject() {
    if (!detail || !reasonCode) return;
    await decide("reject", () => api(`/api/parks/review/${detail.id}/reject`, { method: "POST", body: JSON.stringify({ reasonCode, reason: typedReason || undefined }) }), "The request was rejected");
  }

  function pick(code: ReviewReasonCode) {
    setReasonCode(code);
    setReason(REVIEW_REASONS.find((item) => item.code === code)?.text ?? "");
  }

  return (
    <article className="rv-detail" aria-labelledby="rv-detail-title">
      <header className="rv-detail__head">
        <div>
          <p className="eyebrow">
            {newPark ? <>New OpenStreetMap park · {detail.osm!.type} {detail.osm!.id}</> : <>Parkdex park · <a href={`/parks/${detail.parkId}`} onClick={linkHandler(`/parks/${detail.parkId}`)}>{detail.parkId}</a></>}
          </p>
          <h2 id="rv-detail-title">{detail.parkName} <span className={`rv-status rv-status--${detail.status}`}>{title(detail.status)}</span></h2>
          <p className="muted rv-detail__meta">Asked {timeAgo(detail.createdAt)} by <strong>@{detail.handle ?? "deleted account"}</strong>{detail.otherPending > 0 && <> · {detail.otherPending} more pending for this park</>}</p>
        </div>
      </header>

      {pending && blocked && <Notice>{blocked} Approving is off. Reject the request so the player hears back.</Notice>}

      <div className="rv-detail__grid">
        <figure className="rv-photo">
          {detail.photo.bytes !== null ? (
            <a href={photoUrl} target="_blank" rel="noreferrer" title="Open the full photo">
              <img src={photoUrl} alt={`The photo @${detail.handle ?? "player"} took at ${detail.parkName}`} width={detail.photo.width} height={detail.photo.height} />
            </a>
          ) : <div className="rv-photo__gone"><Icon name="image" size={28} /> The photo was removed 90 days after the decision.</div>}
          <figcaption>{detail.photo.width} × {detail.photo.height} · {bytes(detail.photo.bytes)} · location and camera details removed</figcaption>
        </figure>
        <div className="rv-side">
          <dl className="rv-facts">
            <div><dt>Player</dt><dd>@{detail.handle ?? "deleted account"}</dd></div>
            <div><dt>Taken</dt><dd title={fullDate(detail.checkedAt)}>{fullDate(detail.checkedAt)} ({timeAgo(detail.checkedAt)})</dd></div>
            <div><dt>Position</dt><dd>{detail.position.lat.toFixed(5)}, {detail.position.lng.toFixed(5)} · ±{formatCount(Math.round(detail.position.accuracyM))} m</dd></div>
            <div><dt>Founder</dt><dd>{detail.park.founder ? `@${detail.park.founder.handle ?? "deleted account"}` : "None yet"}</dd></div>
          </dl>
          <CheckAnswers detail={detail} />
        </div>
      </div>

      <div className="map-frame rv-map">
        <ParkMap boundary={detail.geometry} pin={pin} sketch={ring} fitKey={detail.id} pinZoom={17} basemap="satellite" />
      </div>
      <p className="muted map-legend">
        <span className="legend-boundary" /> {newPark ? "OpenStreetMap outline checked" : "Park boundary"}
        <span className="legend-pin" /> Where the player stood
        <span className="legend-sketch" /> Accuracy ±{Math.round(detail.position.accuracyM)} m
      </p>

      {pending ? (
        <div className="rv-decide">
          <section className="rv-decide__card">
            <h3>Approve</h3>
            <p className="muted">Founds the park with this photo as its cover and pays the founder bonus. No flag.</p>
            <button type="button" className="button button--primary" onClick={() => void approve()} disabled={busy !== null || Boolean(blocked)}>
              {busy === "approve" ? <><Spinner small /> Founding</> : <><Icon name="check" size={16} /> Approve...</>}
            </button>
          </section>
          <section className="rv-decide__card">
            <h3>Reject</h3>
            <div className="rv-reasons" role="radiogroup" aria-label="Reason">
              {REVIEW_REASONS.map((item) => (
                <button key={item.code} type="button" role="radio" aria-checked={reasonCode === item.code} className={`chip-toggle${reasonCode === item.code ? " is-on" : ""}`} onClick={() => pick(item.code)}>{item.label}</button>
              ))}
            </div>
            <label className="field">
              <span>What the player reads</span>
              <textarea rows={2} maxLength={300} value={reason} placeholder={reasonCode === "other" ? "Write a short reason." : "Pick a reason above, then edit it if you like."}
                onChange={(event) => { setReason(event.target.value); if (!reasonCode) setReasonCode("other"); }} />
            </label>
            <button type="button" className="button button--danger" onClick={() => void reject()} disabled={busy !== null || !canReject}>
              {busy === "reject" ? <><Spinner small /> Rejecting</> : <><Icon name="close" size={16} /> Reject</>}
            </button>
          </section>
        </div>
      ) : <Decision detail={detail} />}
    </article>
  );
}

export function ReviewPage() {
  const initial = useMemo(readParams, []);
  const [status, setStatus] = useState<ReviewStatus | "all">(initial.status);
  const [selected, setSelected] = useState<string | null>(initial.id);
  const [list, setList] = useState<ReviewList | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<ReviewList>(`/api/parks/review?status=${status}`, { signal: controller.signal })
      .then((loaded) => {
        setList(loaded);
        // Open the oldest request unless one is already chosen.
        setSelected((current) => current ?? loaded.requests[0]?.id ?? null);
      })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorText(reason, "Could not load the review queue.")); });
    return () => controller.abort();
  }, [status, reload]);

  useEffect(() => writeParams(status, selected), [status, selected]);

  function choose(next: string) {
    setStatus(next as ReviewStatus | "all");
    setSelected(null);
    setList(null);
  }

  // After a decision in the pending queue, move on to the next request.
  function decided({ decidedId }: { decidedId: string }) {
    if (status === "pending" && list) {
      const index = list.requests.findIndex((item) => item.id === decidedId);
      const next = list.requests[index + 1] ?? list.requests[index - 1] ?? null;
      setSelected(next?.id ?? null);
    }
    setReload((value) => value + 1);
  }

  const counts = list?.counts;
  const total = counts ? counts.pending + counts.approved + counts.rejected + counts.superseded : undefined;

  return (
    <section className="page page--wide rv" aria-labelledby="review-title">
      <PageHeader
        id="review-title"
        eyebrow="Parks"
        title="Founding reviews"
        lede="Players ask for a second look when the photo check turns down their founding photo. Approve to found the park with that photo as its cover, or reject with a reason they will read."
        actions={<ParksTabs current="/parks/review" />}
      />
      {error && <Notice tone="error" action={<button type="button" className="text-button" onClick={() => setReload((value) => value + 1)}>Try again</button>}>{error}</Notice>}
      {list && !list.available && <Notice>Not in this database yet: founding reviews arrive with the founders_002 migration.</Notice>}

      <div className="rv-body">
        <aside className="rv-queue" aria-label="Requests">
          <div className="rv-queue__filter">
            <Tabs label="Status" value={status} onChange={choose} items={STATUSES.map((item) => ({
              id: item.id, label: item.label,
              count: counts ? (item.id === "all" ? total : counts[item.id as ReviewStatus]) : undefined,
            }))} />
          </div>
          <div className="rv-queue__list">
            {!list && !error && Array.from({ length: 4 }, (_, index) => <div key={index} className="pm-row--skeleton" />)}
            {list?.requests.map((item) => <Row key={item.id} item={item} active={item.id === selected} onOpen={() => setSelected(item.id)} />)}
            {list && list.available && !list.requests.length && (
              <EmptyState compact pose={status === "pending" ? "celebrate" : "sleep"} title={status === "pending" ? "Nothing to review" : "No requests here"}>
                <p className="muted">{status === "pending" ? "New requests appear here, oldest first." : "Requests move here when they are decided."}</p>
              </EmptyState>
            )}
          </div>
        </aside>
        {selected ? <Detail key={selected} id={selected} onDecided={decided} /> : (
          <div className="rv-detail rv-detail--empty"><p className="muted">Pick a request to see the photo, the check's answers and where the player stood.</p></div>
        )}
      </div>
    </section>
  );
}
