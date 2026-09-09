"use client";

import { useEffect } from "react";

const CALLBACK_KEYS = ["code", "state", "error", "error_description"] as const;

export function callbackRedirect(search: string): string {
  const source = new URLSearchParams(search);
  const target = new URLSearchParams();
  for (const key of CALLBACK_KEYS) {
    const values = source.getAll(key);
    if (values.length === 1) target.set(key, values[0]);
  }
  const query = target.toString();
  return query ? `/?${query}` : "/";
}

export default function GoogleCallback() {
  useEffect(() => {
    window.location.replace(callbackRedirect(window.location.search));
  }, []);

  return <main className="native-bootstrap" role="status"><p>Finishing Google sign-in…</p></main>;
}
