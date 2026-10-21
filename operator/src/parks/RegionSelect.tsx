import { useEffect, useState } from "react";
import { api } from "../api";

/**
 * Region picker limited to regions live parks already use, so a typo never creates a new
 * region. A value outside the list (from an older import) stays selectable until changed.
 */

let cached: { key: string; regions: Promise<string[]> } | null = null;

function loadRegions(): Promise<string[]> {
  // The database toggle changes the cookie, so cache per cookie value.
  const key = document.cookie;
  if (!cached || cached.key !== key) {
    const regions = api<{ regions: string[] }>("/api/parks/regions").then((result) => result.regions);
    regions.catch(() => {
      cached = null;
    });
    cached = { key, regions };
  }
  return cached.regions;
}

export function RegionSelect({ value, onChange, disabled }: { value: string; onChange(value: string): void; disabled?: boolean }) {
  const [regions, setRegions] = useState<string[] | null>(null);

  useEffect(() => {
    let active = true;
    loadRegions()
      .then((list) => {
        if (active) setRegions(list);
      })
      .catch(() => {
        if (active) setRegions([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const options = regions ?? [];
  const unknown = value && !options.includes(value);
  return (
    <select value={value} disabled={disabled || !regions} onChange={(event) => onChange(event.target.value)}>
      <option value="">{regions ? "No region" : "Loading regions..."}</option>
      {unknown && <option value={value}>{value} (not used by any live park)</option>}
      {options.map((region) => (
        <option key={region} value={region}>
          {region}
        </option>
      ))}
    </select>
  );
}
