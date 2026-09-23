export function buildGoogleCallbackDestination(search: string): string {
  const incoming = new URLSearchParams(search);
  const outgoing = new URLSearchParams();

  const singleValue = (key: string): string | null => {
    const values = incoming.getAll(key);
    return values.length === 1 ? values[0] : null;
  };

  const state = singleValue("state");
  if (incoming.has("error")) {
    if (state !== null) outgoing.set("state", state);
    const error = singleValue("error");
    if (error !== null) outgoing.set("error", error);
    const description = singleValue("error_description");
    if (description !== null) outgoing.set("error_description", description);
  } else {
    const code = singleValue("code");
    if (code !== null) outgoing.set("code", code);
    if (state !== null) outgoing.set("state", state);
  }

  const query = outgoing.toString();
  return query ? `/account?${query}` : "/account";
}
