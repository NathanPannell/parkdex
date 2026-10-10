import { useEffect, useState } from "react";
import { Icon, Spinner, type IconName } from "../ui";
import { Commands } from "./Commands";
import type { SetupItem } from "./types";

const STATUS: Record<SetupItem["status"], { label: string; icon: IconName }> = {
  done: { label: "Done", icon: "check" },
  todo: { label: "To do", icon: "clock" },
  error: { label: "Problem", icon: "alert" },
  info: { label: "Note", icon: "bulb" },
};

/** Done or to-do for each piece over-the-air updates need, with the exact next step. */
export function SetupChecklist({ items, error, onRetry }: { items: SetupItem[] | null; error: string; onRetry(): void }) {
  const open = items?.filter((item) => item.status === "todo" || item.status === "error").length ?? 0;
  const done = items?.filter((item) => item.status === "done").length ?? 0;
  const counted = items?.filter((item) => item.status !== "info").length ?? 0;
  const [expanded, setExpanded] = useState(true);
  // Fold the list away once everything is done, so a healthy page leads with the channels.
  useEffect(() => { if (items) setExpanded(open > 0); }, [items, open]);

  return (
    <section className="ui-card setup" aria-labelledby="setup-title">
      <header className="ui-card__head">
        <div>
          <h2 className="ui-card__title" id="setup-title">Setup checklist</h2>
          <p className="ui-card__subtitle">{items ? `${done} of ${counted} done${open ? `, ${open} to do` : ""}` : error ? "Could not run the checks" : "Checking the CDN, R2 and the endpoints..."}</p>
        </div>
        <div className="ui-card__actions">
          {error && <button type="button" className="button button--ghost button--small" onClick={onRetry}>Try again</button>}
          {items && (
            <button type="button" className="button button--ghost button--small" aria-expanded={expanded} aria-controls="setup-list" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "Hide" : "Show"} checks
            </button>
          )}
        </div>
      </header>
      {!items && !error && <div className="setup__loading"><Spinner small /> Running checks</div>}
      {error && <p className="setup__error" role="alert">{error}</p>}
      {items && expanded && (
        <ol className="setup__list" id="setup-list">
          {items.map((item) => (
            <li key={item.id} className={`setup-item setup-item--${item.status}`}>
              <span className="setup-item__mark" aria-hidden="true"><Icon name={STATUS[item.status].icon} size={15} /></span>
              <div className="setup-item__body">
                <div className="setup-item__title">
                  <strong>{item.title}</strong>
                  <span className={`setup-pill setup-pill--${item.status}`}>{STATUS[item.status].label}</span>
                </div>
                <p>{item.detail}</p>
                {item.next && <p className="setup-item__next"><span>Next:</span> {item.next}</p>}
                {item.commands && <Commands lines={item.commands} label={`${item.title} commands`} />}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
