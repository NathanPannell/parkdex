import { redirect } from "next/navigation";

export default async function GoogleCallback({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { code, state, error, error_description: errorDescription } = await searchParams;
  const query = new URLSearchParams();
  if (typeof code === "string") query.set("code", code);
  if (typeof state === "string") query.set("state", state);
  if (typeof error === "string") query.set("error", error);
  if (typeof errorDescription === "string") query.set("error_description", errorDescription);
  redirect(`/?${query}`);
}
