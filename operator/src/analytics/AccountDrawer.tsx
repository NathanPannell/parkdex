import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { linkHandler } from "../router";
import { Drawer, formatCount, fullDate, Icon, Spinner, timeAgo, useConfirm, useToast } from "../ui";
import { AccountName, providerLabel } from "./AccountsPage";
import { EventTypeTag } from "./ServerEvents";
import type { AccountDetail, DeletionSetup } from "./types";

const OUTCOMES: Record<string, string> = { planted: "Planted", took: "Took", held: "Held", imported: "Imported claim" };

/** One account: masked email with a recorded reveal, game numbers, recent activity and deletion. */
export function AccountDrawer({ accountId, setup, onClose, onChanged }: { accountId: string | null; setup: DeletionSetup | null; onClose(): void; onChanged(): void }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [account, setAccount] = useState<AccountDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState<"reveal" | "delete" | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    setEmail(null);
    if (!accountId) return;
    const controller = new AbortController();
    setState("loading");
    api<{ account: AccountDetail }>(`/api/analytics/accounts/${accountId}`, { signal: controller.signal })
      .then((result) => { setAccount(result.account); setState("ready"); })
      .catch(() => { if (!controller.signal.aborted) setState("error"); });
    return () => controller.abort();
  }, [accountId, revision]);

  const current = account && account.id === accountId ? account : null;

  async function reveal() {
    if (!current) return;
    setBusy("reveal");
    try {
      setEmail((await api<{ email: string }>(`/api/analytics/accounts/${current.id}/email`, { method: "POST" })).email);
    } catch (reason) {
      toast.show(errorText(reason, "Could not reveal the email."), { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!current) return;
    const resuming = current.deletionState === "deleting";
    const name = current.handle ? `@${current.handle}` : "this account";
    const ok = await confirm({
      title: resuming ? `Finish deleting ${name}?` : `Delete ${name}?`,
      tone: "danger",
      confirmLabel: resuming ? "Resume deletion" : "Delete account",
      body: resuming
        ? <p>This runs the photo and data cleanup again. The account is removed once the photo service confirms every private photo is gone.</p>
        : <>
            <p>This uses the app's own account deletion and cannot be undone:</p>
            <ul>
              <li>Signs the player out on every device.</li>
              <li>Deletes their claims and private photos, through the photo service.</li>
              <li>Deletes their handle, flags, visits and score{current.parksHeld ? `, and drops the ${current.parksHeld} ${current.parksHeld === 1 ? "flag" : "flags"} they hold` : ""}.</li>
              {current.foundedParks > 0 && <li>Removes them as founder of {current.foundedParks} {current.foundedParks === 1 ? "park" : "parks"} with the cover photos. The parks stay live and can be founded again.</li>}
              <li>Server events keep the account ID for up to 90 days, then age out.</li>
            </ul>
          </>,
    });
    if (!ok) return;
    setBusy("delete");
    try {
      const result = await api<{ status: "pending" | "complete" }>(`/api/analytics/accounts/${current.id}/delete`, { method: "POST", body: JSON.stringify({ accountId: current.id }) });
      onChanged();
      if (result.status === "complete") {
        toast.show(`Deleted ${name}.`);
        onClose();
      } else {
        toast.show("Signed out and marked for deletion. The photo service has not confirmed yet; resume it from Deletions in progress.", { tone: "error" });
        setRevision((value) => value + 1);
      }
    } catch (reason) {
      toast.show(errorText(reason, "Could not delete the account."), { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  const eventsLink = current ? `/analytics/events?account=${encodeURIComponent(current.handle ?? current.id)}&range=90d` : "";
  const appLink = current ? `/analytics/events?tab=app&person=${encodeURIComponent(current.id)}` : "";
  const deleteBlocked = !setup?.available;

  return (
    <Drawer open={Boolean(accountId)} onClose={onClose} label="Account">
      <div className="drawer__head">
        <div>
          <p className="eyebrow">Account</p>
          {current ? <h2><AccountName handle={current.handle} id={current.id} /></h2> : <h2>Loading...</h2>}
          {current && <p className="muted an-mono an-account-id">{current.id}</p>}
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close panel"><Icon name="close" size={18} /></button>
      </div>
      {state === "loading" && !current && <div className="drawer__state"><Spinner /> Loading the account...</div>}
      {state === "error" && <div className="drawer__state">This account could not be loaded. It may have been deleted.</div>}
      {current && (
        <div className="drawer__body">
          {current.deletionState === "deleting" && (
            <div className="notice notice--error" role="status"><Icon name="alert" size={18} /><span>Deletion started {current.deletion ? timeAgo(current.deletion.createdAt) : ""}. The account is signed out and waiting on the photo cleanup.</span></div>
          )}
          <div className="panel">
            <h3>Email</h3>
            <div className="an-email-row">
              <span className="an-mono">{email ?? current.maskedEmail}</span>
              {!email && (
                <button type="button" className="button button--small" onClick={reveal} disabled={busy === "reveal"}>
                  {busy === "reveal" ? <Spinner small /> : <Icon name="shield" size={15} />} Reveal
                </button>
              )}
            </div>
            <p className="muted an-small">{current.emailVerified ? "Verified." : "Not verified."} Each reveal is recorded as an operator security event.</p>
          </div>

          <dl className="an-facts">
            <div><dt>Created</dt><dd title={fullDate(current.createdAt)}>{timeAgo(current.createdAt)}</dd></div>
            <div><dt>Last active</dt><dd>{current.lastActiveAt ? timeAgo(current.lastActiveAt) : "Never"}</dd></div>
            <div><dt>Sign-in</dt><dd>{providerLabel(current.providers)}</dd></div>
            <div><dt>Sessions</dt><dd>{formatCount(current.activeSessions)} active</dd></div>
            <div><dt>Visits</dt><dd>{formatCount(current.visits)}</dd></div>
            <div><dt>Flags held</dt><dd>{formatCount(current.parksHeld)}</dd></div>
            <div><dt>Score</dt><dd>{formatCount(current.score)}</dd></div>
            <div><dt>Founded</dt><dd>{formatCount(current.foundedParks)}</dd></div>
          </dl>

          <div className="panel">
            <div className="panel__title-row"><h3>Recent visits</h3></div>
            {current.recentVisits.length ? (
              <ul className="an-mini-list">
                {current.recentVisits.map((visit) => (
                  <li key={`${visit.parkId}-${visit.visitedAt}`}>
                    <span className={`an-outcome an-outcome--${visit.outcome}`}>{OUTCOMES[visit.outcome] ?? visit.outcome}</span>
                    <a href={`/parks/${encodeURIComponent(visit.parkId)}`} onClick={linkHandler(`/parks/${encodeURIComponent(visit.parkId)}`)}>{visit.parkName}</a>
                    <span className="muted" title={fullDate(visit.visitedAt)}>{timeAgo(visit.visitedAt)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="muted an-small">No visits yet.</p>}
          </div>

          {current.founded.length > 0 && (
            <div className="panel">
              <h3>Founded parks</h3>
              <ul className="an-mini-list">
                {current.founded.map((park) => (
                  <li key={park.parkId}>
                    <Icon name="park" size={15} />
                    <a href={`/parks/${encodeURIComponent(park.parkId)}`} onClick={linkHandler(`/parks/${encodeURIComponent(park.parkId)}`)}>{park.parkName}</a>
                    <span className="muted">{timeAgo(park.foundedAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="panel">
            <div className="panel__title-row">
              <h3>Recent server events</h3>
              <a className="text-button an-small" href={eventsLink} onClick={linkHandler(eventsLink)}>Open in explorer</a>
            </div>
            {current.recentEvents.length ? (
              <ul className="an-mini-list an-mini-list--events">
                {current.recentEvents.slice(0, 15).map((event) => (
                  <li key={event.id}>
                    <EventTypeTag type={event.type} />
                    <span className="an-mono an-small an-truncate" title={event.route ?? ""}>{event.route ?? ""}</span>
                    <span className="muted" title={fullDate(event.receivedAt)}>{timeAgo(event.receivedAt)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="muted an-small">No server events in the last 90 days.</p>}
            <p className="an-small"><a className="text-button" href={appLink} onClick={linkHandler(appLink)}>See this player's app events in PostHog</a></p>
          </div>

          <div className="panel an-danger-zone">
            <h3>Delete account</h3>
            <p className="muted an-small">Runs the app's own deletion, so private photos are removed by the photo service and the change is recorded.</p>
            <button type="button" className="button button--danger" onClick={remove} disabled={deleteBlocked || busy === "delete"}>
              {busy === "delete" ? <Spinner small /> : <Icon name="trash" size={16} />} {current.deletionState === "deleting" ? "Resume deletion" : "Delete account"}
            </button>
            {deleteBlocked && setup && <p className="an-small an-danger-zone__why">Off on this deployment: it needs {setup.missing.join(" and ")} so the account's private photos can be deleted too.</p>}
          </div>
        </div>
      )}
    </Drawer>
  );
}
