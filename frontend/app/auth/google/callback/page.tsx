"use client";

import { useEffect } from "react";

import { buildGoogleCallbackDestination } from "@/lib/google-callback";

export const callbackRedirect = buildGoogleCallbackDestination;

export default function GoogleCallback() {
  useEffect(() => {
    window.location.replace(buildGoogleCallbackDestination(window.location.search));
  }, []);

  return <main className="native-bootstrap" role="status"><p>Finishing Google sign-in…</p></main>;
}
