import { linkHandler } from "../router";
import { Icon, type IconName } from "../ui";

const TABS: { path: string; label: string; icon: IconName }[] = [
  { path: "/proposals", label: "From players", icon: "pin" },
  { path: "/proposals/import", label: "Import from map", icon: "download" },
  { path: "/proposals/drafts", label: "Drafts", icon: "edit" },
];

export function ParksTabs({ current }: { current: string }) {
  return (
    <nav className="subnav" aria-label="Park sections">
      {TABS.map((tab) => {
        const on = tab.path === "/proposals" ? current === "/proposals" : current.startsWith(tab.path);
        return (
          <a key={tab.path} href={tab.path} className={`subnav__item${on ? " is-on" : ""}`} aria-current={on ? "page" : undefined} onClick={linkHandler(tab.path)}>
            <Icon name={tab.icon} size={16} /> {tab.label}
          </a>
        );
      })}
    </nav>
  );
}
