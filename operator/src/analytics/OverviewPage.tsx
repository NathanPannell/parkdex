import { useEffect, useMemo, useState } from "react";
import { api, errorText } from "../api";
import { linkHandler } from "../router";
import { useDashboard } from "../shell/DashboardContext";
import { Card, formatCount, fullDate, Icon, Notice, PageHeader, StatGrid, StatTile, Tabs } from "../ui";
import { BarList, dayStamps, TimeChart } from "./charts";
import type { Overview, Period } from "./types";
import { NotYet } from "./NotYet";

const PERIODS = [7, 30, 90] as const;
const FLAG_LABELS: Record<string, string> = {
  people: "People in the photo",
  lighting: "Too dark or blurry",
  not_park: "Not this park",
  inappropriate: "Inappropriate",
  not_photo: "Not a photo",
  personal_info: "Personal information",
};

/** "+12% vs previous 30 days", coloured by direction. Rises are good for every tile here. */
function Delta({ period, days }: { period: Period; days: number }) {
  const { current, previous } = period;
  if (!previous && !current) return <span className="an-delta">No change vs prior {days}d</span>;
  if (!previous) return <span className="an-delta an-delta--up">New this period</span>;
  const change = Math.round(((current - previous) / previous) * 100);
  const tone = change > 0 ? "up" : change < 0 ? "down" : "flat";
  return (
    <span className={`an-delta an-delta--${tone}`}>
      {change > 0 ? "+" : ""}
      {change}% vs prior {days}d
    </span>
  );
}

function percent(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : "—";
}

/** Headline numbers and daily charts for the database on screen. */
export function OverviewPage() {
  const { environment } = useDashboard();
  const [days, setDays] = useState<number>(30);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<{ overview: Overview }>(`/api/analytics/overview?days=${days}`, { signal: controller.signal })
      .then((result) => setOverview(result.overview))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorText(reason, "Could not load the overview."));
      });
    return () => controller.abort();
  }, [days, revision]);

  const o = overview && overview.days === days ? overview : null;
  const x = useMemo(() => (o ? dayStamps(o.series.days) : []), [o]);
  const accountSeries = useMemo(() => (o ? [{ label: "New accounts", values: o.series.newAccounts, color: "--kip" }] : []), [o]);
  const activeSeries = useMemo(() => (o ? [{ label: "Active players", values: o.series.activePlayers, color: "--moss" }] : []), [o]);
  const visitSeries = useMemo(
    () =>
      o
        ? [
            { label: "Plants", values: o.series.planted, color: "--moss" },
            { label: "Takes", values: o.series.took, color: "--kip" },
            { label: "Holds", values: o.series.held, color: "--sun" },
          ]
        : [],
    [o],
  );
  const foundingSeries = useMemo(() => (o?.series.foundings ? [{ label: "Parks founded", values: o.series.foundings, color: "--grape" }] : []), [o]);
  const foundersMissing = Boolean(o && !o.founded);

  const visitsNow = o ? o.visits.planted.current + o.visits.took.current + o.visits.held.current : undefined;
  const visitsBefore = o ? o.visits.planted.previous + o.visits.took.previous + o.visits.held.previous : 0;
  const checks = o?.photoChecks;
  const topFlag = o?.rejectionFlags[0];

  return (
    <section className="page analytics" aria-labelledby="overview-title">
      <PageHeader
        id="overview-title"
        eyebrow="Analytics"
        title="Overview"
        lede={
          <>
            How many people play and what they do in parks, from the <strong>{environment || "selected"}</strong> database. Days follow Victoria time.
          </>
        }
        actions={
          <>
            <Tabs
              label="Period"
              value={String(days)}
              onChange={(id) => setDays(Number(id))}
              items={PERIODS.map((value) => ({ id: String(value), label: `${value} days` }))}
            />
            <button type="button" className="icon-button" onClick={() => setRevision((value) => value + 1)} aria-label="Refresh" title="Refresh">
              <Icon name="refresh" size={18} />
            </button>
          </>
        }
      />
      {o && o.unavailable.length > 0 && (
        <Notice>This database is a release behind ({o.unavailable.join(", ")}), so park founding numbers are not in it yet. Everything else is current.</Notice>
      )}
      {error && (
        <Notice
          tone="error"
          action={
            <button type="button" className="text-button" onClick={() => setRevision((value) => value + 1)}>
              Try again
            </button>
          }
        >
          {error}
        </Notice>
      )}

      <StatGrid>
        <StatTile
          label="Accounts"
          icon="users"
          tone="kip"
          value={o?.accounts.total}
          hint={
            o && (
              <>
                <span>
                  +{formatCount(o.accounts.new7)} in 7 days, +{formatCount(o.accounts.new30)} in 30
                </span>
                <Delta period={o.accounts.period} days={days} />
              </>
            )
          }
        />
        <StatTile
          label="Signed-in players"
          icon="activity"
          tone="moss"
          value={o ? `${formatCount(o.players.week.current)} / wk` : undefined}
          hint={
            o && (
              <>
                <span>
                  {formatCount(o.players.day.current)} today, {formatCount(o.players.month.current)} this month
                </span>
                <Delta period={o.players.week} days={7} />
              </>
            )
          }
        />
        <StatTile
          label="Players with handles"
          icon="user"
          tone="sea"
          value={o?.accounts.withHandle}
          hint={
            o && (
              <span>
                {percent(o.accounts.withHandle, o.accounts.total)} of accounts{o.accounts.deleting ? `, ${o.accounts.deleting} deleting` : ""}
              </span>
            )
          }
        />
        <StatTile
          label="Parks founded"
          icon="park"
          tone="grape"
          value={o ? (o.founded?.total ?? null) : undefined}
          hint={
            o &&
            (o.founded ? (
              <>
                <span>+{formatCount(o.founded.new7)} in 7 days</span>
                <Delta period={o.founded.period} days={days} />
              </>
            ) : (
              <span>Not in this database yet</span>
            ))
          }
        />
        <StatTile
          label={`Visits, ${days} days`}
          icon="flag"
          tone="sun"
          value={visitsNow}
          hint={
            o && (
              <>
                <span>
                  {formatCount(o.visits.planted.current)} plants, {formatCount(o.visits.took.current)} takes, {formatCount(o.visits.held.current)} holds
                </span>
                <Delta period={{ current: visitsNow ?? 0, previous: visitsBefore }} days={days} />
              </>
            )
          }
        />
        <StatTile
          label="Photo approve rate"
          icon="image"
          tone="moss"
          value={o ? (checks ? percent(checks.approved.current, checks.total.current) : null) : undefined}
          hint={
            foundersMissing ? (
              <span>Not in this database yet</span>
            ) : (
              checks && (
                <span>
                  {formatCount(checks.total.current)} checks{topFlag ? `, most often "${FLAG_LABELS[topFlag.flag] ?? topFlag.flag}"` : ""}
                </span>
              )
            )
          }
        />
        <StatTile
          label="Open feedback"
          icon="inbox"
          tone="kip"
          value={o?.feedbackOpen}
          hint={
            <a href="/feedback" onClick={linkHandler("/feedback")}>
              Open the board
            </a>
          }
        />
      </StatGrid>

      <div className="an-chart-grid">
        <Card title="New accounts" subtitle="Accounts created per day">
          {o ? <TimeChart label="New accounts per day" x={x} series={accountSeries} kind="bars" /> : <ChartLoading />}
        </Card>
        <Card title="Active players" subtitle="Signed-in accounts with at least one server event that day">
          {o ? <TimeChart label="Active players per day" x={x} series={activeSeries} kind="line" /> : <ChartLoading />}
        </Card>
        <Card title="Visits by outcome" subtitle="Counted visits per day: plants, takes and holds">
          {o ? <TimeChart label="Visits per day by outcome" x={x} series={visitSeries} kind="stacked" /> : <ChartLoading />}
        </Card>
        <Card title="Foundings" subtitle="Parks founded per day (current founders)">
          {!o ? (
            <ChartLoading />
          ) : foundersMissing ? (
            <NotYet notes={o.unavailable} />
          ) : (
            <TimeChart label="Parks founded per day" x={x} series={foundingSeries} kind="bars" />
          )}
        </Card>
        <Card title="Top parks" subtitle={`Most visited in the last ${days} days`}>
          {o ? (
            <BarList
              tone="var(--sun)"
              empty={`No visits in the last ${days} days.`}
              rows={o.topParks.map((park) => ({
                key: park.parkId,
                label: (
                  <a href={`/parks/${encodeURIComponent(park.parkId)}`} onClick={linkHandler(`/parks/${encodeURIComponent(park.parkId)}`)} title={park.parkId}>
                    {park.name}
                  </a>
                ),
                value: park.visits,
                detail: `· ${formatCount(park.players)} ${park.players === 1 ? "player" : "players"}`,
              }))}
            />
          ) : (
            <ChartLoading />
          )}
        </Card>
        <Card title="Photo checks" subtitle={`Founding photos in the last ${days} days, and why they were turned down`}>
          {foundersMissing ? (
            <NotYet notes={o!.unavailable} />
          ) : checks ? (
            <>
              <div className="an-check-split" aria-label="Photo check outcomes">
                {(
                  [
                    ["Approved", checks.approved.current, "moss"],
                    ["Rejected", checks.rejected, "kip"],
                    ["Unsure", checks.unsure, "sun"],
                    ["Unavailable", checks.unavailable, "faint"],
                  ] as const
                ).map(([name, value, tone]) => (
                  <div key={name} className={`an-check-split__item an-check-split__item--${tone}`}>
                    <strong>{formatCount(value)}</strong>
                    <span>{name}</span>
                  </div>
                ))}
              </div>
              <BarList
                tone="var(--berry)"
                empty="No rejection flags in this period."
                rows={o!.rejectionFlags.map((flag) => ({ key: flag.flag, label: FLAG_LABELS[flag.flag] ?? flag.flag, value: flag.count }))}
              />
            </>
          ) : (
            <ChartLoading />
          )}
        </Card>
      </div>
      {o && (
        <p className="muted an-foot">
          Updated {fullDate(o.generatedAt)}. Signed-in players count accounts with a server event in the last 24 hours, 7 days and 30 days.
        </p>
      )}
    </section>
  );
}

function ChartLoading() {
  return <div className="an-chart an-chart--loading" aria-hidden="true" />;
}
