import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { formatCount } from "../ui";

/**
 * Charts for the analytics pages, drawn with uPlot: about 50 KB, canvas-based, and fast with
 * thousands of points, which the hourly event histogram needs. Rankings (top parks, rejection
 * flags) are plain HTML bars, which read better as lists and need no library at all.
 */

export type ChartSeries = { label: string; values: number[]; color: string };

function useDarkMode(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const sync = () => setDark(query.matches);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return dark;
}

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

const DAY_LABEL = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const HOUR_LABEL = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric" });

/** Victoria calendar days from the API, placed at local noon so bars sit centred on their day. */
export function dayStamps(days: string[]): number[] {
  return days.map((day) => new Date(`${day}T12:00:00`).getTime() / 1000);
}

/**
 * A time series as bars, a line, or stacked bars (each series on top of the one before it).
 * Hovering shows each series' own value for that day in the legend.
 */
export function TimeChart({
  x,
  series,
  kind,
  height = 210,
  bucket = "day",
  label,
}: {
  x: number[];
  series: ChartSeries[];
  kind: "bars" | "line" | "stacked";
  height?: number;
  bucket?: "day" | "hour";
  label: string;
}) {
  const [host, width] = useWidth<HTMLDivElement>();
  const plotHost = useRef<HTMLDivElement>(null);
  const dark = useDarkMode();

  useEffect(() => {
    if (!plotHost.current || width < 50) return;
    const css = getComputedStyle(document.documentElement);
    const color = (value: string) => (value.startsWith("--") ? css.getPropertyValue(value).trim() : value) || "#888";
    const ink = color("--ink-soft");
    const grid = color("--line");
    const font = "600 11px Figtree Variable, system-ui, sans-serif";
    const raw = series.map((item) => item.values);
    // Stacked bars draw the running total first, so each later (shorter) bar sits on top of it.
    const order = kind === "stacked" ? [...series.keys()].reverse() : [...series.keys()];
    const drawn = order.map((index) =>
      kind === "stacked" ? raw[0].map((_, at) => raw.slice(0, index + 1).reduce((sum, values) => sum + (values[at] ?? 0), 0)) : raw[index],
    );
    const bars = kind !== "line" ? uPlot.paths.bars?.({ size: [0.72, 26], gap: 1 }) : undefined;
    const format = bucket === "hour" ? HOUR_LABEL : DAY_LABEL;
    const plot = new uPlot(
      {
        width,
        height,
        padding: [10, 8, 0, 0],
        cursor: { drag: { x: false, y: false }, points: { size: 7 } },
        legend: { live: true },
        scales: { x: { time: true }, y: { range: (_u, _min, max) => [0, Math.max(4, Math.ceil(max * 1.12))] } },
        axes: [
          {
            stroke: ink,
            font,
            grid: { stroke: grid, width: 1 },
            ticks: { stroke: grid, width: 1, size: 4 },
            // Whole days (or whole hours) only, so a label never repeats inside one bucket.
            incrs:
              bucket === "hour"
                ? [3600, 2 * 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 7 * 86400]
                : [86400, 2 * 86400, 3 * 86400, 7 * 86400, 14 * 86400, 28 * 86400],
            values: (_u, ticks) => ticks.map((tick) => format.format(new Date(tick * 1000))),
          },
          {
            stroke: ink,
            font,
            size: 46,
            grid: { stroke: grid, width: 1 },
            ticks: { show: false },
            values: (_u, ticks) => ticks.map((tick) => (Number.isInteger(tick) ? formatCount(tick) : "")),
          },
        ],
        series: [
          { label: bucket === "hour" ? "Hour" : "Day", value: (_u, value) => (value === null ? "" : format.format(new Date(value * 1000))) },
          ...order.map((index) => {
            const tone = color(series[index].color);
            return {
              label: series[index].label,
              stroke: tone,
              width: kind === "line" ? 2.5 : 0,
              fill: kind === "line" ? `${tone}22` : tone,
              paths: bars,
              points: { show: kind === "line" && x.length <= 31, size: 5, fill: tone },
              value: (_u: uPlot, _value: number | null, _series: number, at: number | null) => (at === null ? "" : formatCount(raw[index][at] ?? 0)),
            } satisfies uPlot.Series;
          }),
        ],
      },
      [x, ...drawn],
      plotHost.current,
    );
    return () => plot.destroy();
  }, [width, x, series, kind, height, bucket, dark]);

  return (
    <div className="an-chart" ref={host} role="img" aria-label={label}>
      <div ref={plotHost} />
    </div>
  );
}

/** A ranked list with a bar per row, for top parks and rejection reasons. */
export function BarList({
  rows,
  tone = "var(--sea)",
  empty,
}: {
  rows: { key: string; label: ReactNode; value: number; detail?: ReactNode }[];
  tone?: string;
  empty: ReactNode;
}) {
  if (!rows.length) return <p className="muted an-bar-list__empty">{empty}</p>;
  const max = Math.max(...rows.map((row) => row.value), 1);
  return (
    <ol className="an-bar-list">
      {rows.map((row) => (
        <li key={row.key} className="an-bar-list__row">
          <div className="an-bar-list__label">{row.label}</div>
          <div className="an-bar-list__track" aria-hidden="true">
            <span style={{ width: `${Math.max(2, (row.value / max) * 100)}%`, background: tone }} />
          </div>
          <div className="an-bar-list__value">
            {formatCount(row.value)}
            {row.detail && <span className="muted"> {row.detail}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}
