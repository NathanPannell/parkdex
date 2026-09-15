export function buildGoogleCallbackDestination(search: string): string {
  const incoming = new URLSearchParams(search);
  const outgoing = new URLSearchParams();

  const state = incoming.get("state");
  const error = incoming.get("error");
  if (error !== null) {
    outgoing.set("error", error);
    const description = incoming.get("error_description");
    if (description !== null) outgoing.set("error_description", description);
  } else {
    const code = incoming.get("code");
    if (code !== null) outgoing.set("code", code);
  }
  if (state !== null) outgoing.set("state", state);

  const query = outgoing.toString();
  return query ? `/?${query}` : "/";
}
