import type { ReactNode } from "react";
import { Card, Icon, Kip, PageHeader } from "../ui";

/**
 * A page that says what is coming. Sections replace it with the real page; delete this file
 * once nothing imports it.
 */
export function Placeholder({ eyebrow, title, lede, items, issue = 135, children }: {
  eyebrow: string;
  title: string;
  lede: ReactNode;
  /** What the finished page will do, one line each. */
  items: string[];
  issue?: number;
  children?: ReactNode;
}) {
  return (
    <section className="page" aria-labelledby="placeholder-title">
      <PageHeader id="placeholder-title" eyebrow={eyebrow} title={title} lede={lede} />
      <Card className="coming">
        <div className="coming__body">
          <Kip pose="map" size={88} className="coming__kip" />
          <div>
            <p className="coming__label"><Icon name="clock" size={15} /> Coming next</p>
            <ul className="coming__list">
              {items.map((item) => <li key={item}><Icon name="check" size={15} /> {item}</li>)}
            </ul>
            <p className="muted coming__issue">Tracked in issue #{issue}.</p>
          </div>
        </div>
      </Card>
      {children}
    </section>
  );
}
