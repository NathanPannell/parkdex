import { Badge } from "../components/Badge";
import { useContent } from "../lib/content/provider";
import { Kip } from "../components/Kip";

// Design review sheet: one badge per biome and shape, reachable at /#gallery.
export function Gallery() {
  const content = useContent();
  const seen = new Set<string>();
  const picks = (content?.parks ?? []).filter((p) => {
    const key = `${p.biome}-${p.shape}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return (
    <div className="scroll" style={{ height: "100%", padding: 16, display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "center", background: "#FFF8EC" }}>
      {content ? picks.map((p) => (
        <div key={p.id} style={{ textAlign: "center", fontSize: 11, fontWeight: 700 }}>
          <Badge park={p} size={160} state="earned" animated />
          <div>
            {p.biome} · {p.shape} · {p.rarity}
          </div>
        </div>
      )) : <Kip pose="think" size={120} />}
    </div>
  );
}
