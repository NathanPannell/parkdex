const PAGES = [
  { href: "/feedback/review", label: "Feedback" },
  { href: "/operator/proposals", label: "Park proposals" },
  { href: "/operator/builds", label: "Build config" },
] as const;

/** Links between the private operator pages, which share one sign-in. */
export function OperatorNav() {
  const current = typeof location === "undefined" ? "" : location.pathname;
  return (
    <nav className="operator-nav" aria-label="Operator pages">
      {PAGES.map((page) => (
        <a key={page.href} className={`fr-button ${page.href === current ? "fr-button--primary" : "fr-button--paper"}`} href={page.href} aria-current={page.href === current ? "page" : undefined}>
          {page.label}
        </a>
      ))}
    </nav>
  );
}
