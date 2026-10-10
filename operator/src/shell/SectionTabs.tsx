import { SECTIONS, type SectionId } from "../routes";
import { Tabs } from "../ui";

/** The sub-route tabs for a section, from the route table, so they always match the sidebar. */
export function SectionTabs({ section, path }: { section: SectionId; path: string }) {
  const children = SECTIONS.find((item) => item.id === section)?.children ?? [];
  const current = children.find((child) => path === child.path || path.startsWith(`${child.path}/`))?.path ?? "";
  return (
    <div className="section-tabs">
      <Tabs label="Pages in this section" value={current} items={children.map((child) => ({ id: child.path, label: child.label, icon: child.icon, href: child.path }))} />
    </div>
  );
}
