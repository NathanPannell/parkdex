import { useEffect, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { api, errorText, uploadImage, type Draft } from "../api";
import { Icon, Spinner, useToast } from "../ui";

/**
 * Find a reference photo without leaving the draft: Bing image search embedded in the page,
 * plus quick picks from Wikimedia Commons. Drag a Bing image onto the drop zone, paste an
 * image or its address, or click a quick pick.
 */

type WebPhoto = { title: string; thumbUrl: string; pageUrl: string; match: "name" | "nearby" };
type Tab = "bing" | "picks";

function bingUrl(query: string): string {
  return `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2`;
}

/** Pulls an image address out of whatever a drag or paste carried. */
function addressFrom(data: DataTransfer): string | null {
  const html = data.getData("text/html");
  const fromHtml = html && /<img[^>]+src=["']([^"']+)["']/i.exec(html)?.[1];
  const uri = data.getData("text/uri-list").split(/\r?\n/).find((line) => line && !line.startsWith("#"));
  const text = data.getData("text/plain").trim();
  const candidate = fromHtml || uri || text;
  return candidate && /^(https:|data:image\/)/i.test(candidate) ? candidate.replace(/&amp;/g, "&") : null;
}

async function dataUrlFile(address: string): Promise<File> {
  const blob = await (await fetch(address)).blob();
  return new File([blob], "reference", { type: blob.type });
}

export function ReferenceFinder({ draft, onChange }: { draft: Draft; onChange(draft: Draft): void }) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("bing");
  const [query, setQuery] = useState(() => [draft.name, draft.region].filter(Boolean).join(" "));
  const [frameQuery, setFrameQuery] = useState(query);
  const [picks, setPicks] = useState<WebPhoto[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [address, setAddress] = useState("");

  useEffect(() => {
    if (tab !== "picks" || picks) return;
    const controller = new AbortController();
    api<{ photos: WebPhoto[] }>(`/api/drafts/${encodeURIComponent(draft.id)}/photos?q=${encodeURIComponent(frameQuery)}`, { signal: controller.signal })
      .then((result) => setPicks(result.photos))
      .catch(() => { if (!controller.signal.aborted) setPicks([]); });
    return () => controller.abort();
  }, [tab, picks, draft.id, frameQuery]);

  async function useAddress(value: string, label = value) {
    setBusy(label);
    try {
      const result = value.startsWith("data:")
        ? await uploadImage<{ draft: Draft }>(`/api/drafts/${encodeURIComponent(draft.id)}/reference`, await dataUrlFile(value))
        : await api<{ draft: Draft }>(`/api/drafts/${encodeURIComponent(draft.id)}/reference-from-web`, { method: "POST", body: JSON.stringify({ url: value }) });
      onChange(result.draft);
      setAddress("");
      toast.show("Reference photo set");
    } catch (reason) {
      toast.show(errorText(reason, "That image could not be used. Try another one."), { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function useFile(file: File) {
    setBusy("file");
    try {
      const { draft: saved } = await uploadImage<{ draft: Draft }>(`/api/drafts/${encodeURIComponent(draft.id)}/reference`, file);
      onChange(saved);
      toast.show("Reference photo set");
    } catch (reason) {
      toast.show(errorText(reason, "That image could not be used."), { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  function take(data: DataTransfer) {
    const file = [...data.files].find((item) => item.type.startsWith("image/"));
    if (file) return void useFile(file);
    const found = addressFrom(data);
    if (found) return void useAddress(found);
    toast.show("Drop an image, or paste its address.", { tone: "error" });
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setOver(false);
    take(event.dataTransfer);
  }

  function onPaste(event: ClipboardEvent) {
    if ((event.target as HTMLElement).tagName === "INPUT") return;
    event.preventDefault();
    take(event.clipboardData);
  }

  function search(event: FormEvent) {
    event.preventDefault();
    setFrameQuery(query.trim() || draft.name);
    setPicks(null);
  }

  return (
    <section className="panel finder" onPaste={onPaste}>
      <div className="finder__head">
        <h3>Find a reference photo</h3>
        <div className="finder__tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "bing"} className={`chip-toggle${tab === "bing" ? " is-on" : ""}`} onClick={() => setTab("bing")}>Bing images</button>
          <button type="button" role="tab" aria-selected={tab === "picks"} className={`chip-toggle${tab === "picks" ? " is-on" : ""}`} onClick={() => setTab("picks")}>Quick picks</button>
        </div>
      </div>

      <form className="finder__search" onSubmit={search}>
        <label className="search">
          <Icon name="search" size={16} />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Image search" />
        </label>
        <button type="submit" className="button button--ghost button--small">Search</button>
      </form>

      {tab === "bing" ? (
        <>
          <iframe className="finder__frame" title="Bing image search" src={bingUrl(frameQuery)} referrerPolicy="no-referrer" loading="lazy" />
          <div
            className={`finder__drop${over ? " is-over" : ""}`}
            tabIndex={0}
            onDragOver={(event) => { event.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            {busy ? <><Spinner small /> Attaching photo...</> : <><Icon name="download" size={18} /> Drag an image from Bing here, or click here and paste one</>}
          </div>
          <form className="finder__address" onSubmit={(event) => { event.preventDefault(); if (address.trim()) void useAddress(address.trim()); }}>
            <input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Or paste an image address (right-click an image, Copy image address)" aria-label="Image address" />
            <button type="submit" className="button button--ghost button--small" disabled={!address.trim() || Boolean(busy)}>Use</button>
          </form>
        </>
      ) : (
        <div className="finder__picks">
          {!picks && <div className="drawer__state"><Spinner small /> Searching Wikimedia Commons...</div>}
          {picks?.length === 0 && <p className="muted">No photos found. Try the Bing tab or a shorter search.</p>}
          {picks?.map((photo) => (
            <button key={photo.thumbUrl} type="button" className="finder__pick" disabled={Boolean(busy)} onClick={() => void useAddress(photo.thumbUrl, photo.thumbUrl)} title={photo.title}>
              <img src={photo.thumbUrl} alt={photo.title} loading="lazy" referrerPolicy="no-referrer" />
              <span>{busy === photo.thumbUrl ? <Spinner small /> : photo.match === "nearby" ? "Near the pin" : photo.title}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
