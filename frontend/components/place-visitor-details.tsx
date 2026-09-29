import { ChevronDown, ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import type { PlaceVisitorDetails as VisitorDetailsRecord } from "@/lib/visitor-details";
import type { VisitorInformation } from "@/lib/visitor-information";
import styles from "./place-visitor-details.module.css";

type Props = {
  details?: VisitorDetailsRecord | null;
  visitorFallback?: VisitorInformation;
  leadOverview?: string | null;
};

function hasText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeHttpUrl(value: string | null | undefined): string | null {
  if (!hasText(value) || value !== value.trim() || /[\u0000-\u0020\u007f]/u.test(value)) return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname || parsed.username || parsed.password) return null;
    return value;
  } catch {
    return null;
  }
}

function safeEmailHref(value: string | null | undefined): string | null {
  if (!hasText(value) || !/^[A-Z0-9.!#$%&'*+/_~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+$/iu.test(value)) return null;
  return `mailto:${encodeURIComponent(value.trim())}`;
}

function safeTelephoneHref(value: string | null | undefined): string | null {
  if (!hasText(value)) return null;
  const compact = value.trim().replace(/[\s().-]/gu, "");
  if (!/^\+?\d{3,}$/u.test(compact)) return null;
  return `tel:${compact}`;
}

function safeExternalLink(href: string | null, children: ReactNode, className?: string) {
  return href ? <a className={className} href={href} target="_blank" rel="noreferrer">{children}</a> : children;
}

function safeContactLink(href: string | null, children: ReactNode, className?: string) {
  return href ? <a className={className} href={href}>{children}</a> : children;
}

function LinkifiedText({ value }: { value: string }) {
  const pieces: ReactNode[] = [];
  const urlPattern = /https?:\/\/[^\s<>"']+/giu;
  let lastIndex = 0;
  for (const match of value.matchAll(urlPattern)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const trailing = raw.match(/[.,!?;:)}\]]+$/u)?.[0] ?? "";
    const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
    const href = safeHttpUrl(candidate);
    if (!href) continue;
    pieces.push(value.slice(lastIndex, start));
    pieces.push(<a key={`${start}-${href}`} href={href} target="_blank" rel="noreferrer">{candidate}</a>);
    if (trailing) pieces.push(trailing);
    lastIndex = start + raw.length;
  }
  if (!pieces.length) return <>{value}</>;
  pieces.push(value.slice(lastIndex));
  return <>{pieces}</>;
}

function TextParagraphs({ value }: { value: string }) {
  return <div className={styles.paragraphs}>{value.split(/\n\s*\n/u).map((paragraph, index) => {
    const trimmed = paragraph.trim();
    return trimmed ? <p key={index}><LinkifiedText value={trimmed} /></p> : null;
  })}</div>;
}

function formatCheckedDate(value: string | null | undefined): string | null {
  if (!hasText(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function scopeNote(details: VisitorDetailsRecord): string | null {
  const { kind, matchedName, parentName } = details.scope;
  const place = matchedName || ({ park: "park", site: "named site", island: "island", community: "community", dataset: "place dataset" } as const)[kind];
  const parent = parentName ? ` within ${parentName}` : "";
  const communityNote = kind === "community" ? " Community-wide details may be outside the place pin." : "";
  const islandNote = kind === "island" ? " Information covers the island." : "";
  return `Information applies to ${place}${parent}.${communityNote}${islandNote}`;
}

function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return <details className={styles.disclosure}>
    <summary tabIndex={0}><span>{title}</span><ChevronDown size={17} aria-hidden="true" /></summary>
    <div className={styles.sectionBody}>
      {children}
    </div>
  </details>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className={styles.field}>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>;
}

function NameDetailList({ items }: { items: Array<{ name: string; details: string | null }> }) {
  return <ul className={styles.nameList}>{items.map((item, index) => <li key={`${item.name}-${index}`}>
    <strong>{item.name}</strong>
    {item.details && <TextParagraphs value={item.details} />}
  </li>)}</ul>;
}

function overviewParagraphs(value: string) {
  return value.split(/\n\s*\n/u).map((paragraph) => paragraph.trim()).filter(Boolean);
}

function makeOverviewLead(value: string): string {
  const paragraphs = overviewParagraphs(value);
  const firstParagraph = paragraphs[0] ?? value.trim();
  if (paragraphs.length === 1 && value.length <= 360) return value.trim();
  const firstSentence = firstParagraph.match(/^.*?[.!?](?:\s|$)/u)?.[0]?.trim();
  if (firstSentence) return firstSentence;
  return `${firstParagraph.slice(0, 260).trimEnd()}…`;
}

function OverviewDisclosure({ overview }: { overview: string }) {
  return <details className={styles.overviewDisclosure}>
    <summary tabIndex={0}><span>More about this place</span><ChevronDown size={17} aria-hidden="true" /></summary>
    <TextParagraphs value={overview} />
  </details>;
}

function sourceLinks(details: VisitorDetailsRecord | null | undefined) {
  const primaryUrl = safeHttpUrl(details?.source.primaryUrl);
  const geographicUrl = safeHttpUrl(details?.source.geographicSourceUrl);
  const sourceKind = details?.source.kind;
  const primaryIsVisitorInformation = sourceKind === "visitor_page" || sourceKind === "official_park_api";
  return { primaryUrl, geographicUrl, primaryIsVisitorInformation };
}

export function PlaceVisitorDetails({ details, visitorFallback, leadOverview }: Props) {
  const { primaryUrl, geographicUrl, primaryIsVisitorInformation } = sourceLinks(details);
  const fallbackUrl = safeHttpUrl(visitorFallback?.url);
  const visitorUrl = primaryIsVisitorInformation && primaryUrl ? primaryUrl : fallbackUrl;
  const visitorAuthority = primaryIsVisitorInformation && primaryUrl ? details?.source.authority : visitorFallback?.authority;
  const checkedDate = formatCheckedDate(details?.source.retrievedAt);
  const overview = hasText(details?.overview) ? details.overview.trim() : null;
  const showOverviewDisclosure = Boolean(overview && (!leadOverview || normalizedText(overview) !== normalizedText(leadOverview)));
  const sourceLinkLabel = details?.source.authority || "Primary source";
  const hasAccess = Boolean(
    hasText(details?.access.directions)
    || hasText(details?.access.address)
    || hasText(details?.access.transportNotes)
    || details?.access.entryPoints?.length,
  );
  const hasActivities = Boolean(details?.activities?.length);
  const hasFacilities = Boolean(details?.facilities?.length);
  const hasTrailsOrMaps = Boolean(details?.trails?.length || details?.maps?.some((map) => map.title || map.url || map.kind) || hasText(details?.mapNotes));
  const hasOperations = Boolean(
    hasText(details?.operations.hours)
    || hasText(details?.operations.seasons)
    || hasText(details?.operations.notes)
    || safeHttpUrl(details?.officialUpdatesUrl),
  );
  const hasRules = Boolean(
    hasText(details?.rules.pets)
    || hasText(details?.rules.cycling)
    || hasText(details?.rules.campfires)
    || details?.rules.other?.length,
  );
  const hasCamping = Boolean(
    hasText(details?.camping.summary)
    || details?.camping.reservationRequired !== null && details?.camping.reservationRequired !== undefined
    || safeHttpUrl(details?.camping.bookingUrl)
    || hasText(details?.camping.reservationNotes)
    || hasText(details?.camping.fees),
  );
  const hasAccessibility = Boolean(hasText(details?.accessibility.summary) || details?.accessibility.features?.length);
  const visibleContacts = details?.contacts?.filter((contact) =>
    hasText(contact.name) || hasText(contact.role) || hasText(contact.phone) || hasText(contact.email) || safeHttpUrl(contact.url),
  ) ?? [];
  const hasBackground = Boolean(
    hasText(details?.background.history)
    || hasText(details?.background.conservation)
    || hasText(details?.background.culturalContext)
    || hasText(details?.background.wildlife),
  );

  return <>
    {details && showOverviewDisclosure && overview && <OverviewDisclosure overview={overview} />}
    <section className={`place-visit-info ${styles.visitInfo}`}>
      <h3>Plan your visit</h3>
      {visitorUrl
        ? <a className="official-visitor-link" href={visitorUrl} target="_blank" rel="noreferrer">
          <span><strong>Official visitor information</strong><small>Access, facilities and park updates{visitorAuthority ? ` · ${visitorAuthority}` : ""}</small></span>
          <ArrowUpRight size={18} aria-hidden="true" />
        </a>
        : <p className="place-visitor-unavailable">Official visitor information is not available for this place yet.</p>}
      {details && <div className={styles.sourceLine}>
        {primaryUrl && !primaryIsVisitorInformation && <span>{safeExternalLink(primaryUrl, <>Source: {sourceLinkLabel}</>, styles.sourceLink)}</span>}
        {primaryUrl && primaryIsVisitorInformation && <span>Source: {details.source.authority || "official source"}</span>}
        {geographicUrl && geographicUrl !== primaryUrl && <span>{safeExternalLink(geographicUrl, "Geographic source", styles.sourceLink)}</span>}
        <span>{scopeNote(details)}</span>
        {checkedDate && <span>Source checked {checkedDate}</span>}
      </div>}
      {details && <div className={styles.disclosures}>
        {hasAccess && <Disclosure title="Getting here">
          <dl className={styles.fields}>
            {hasText(details.access.directions) && <Field label="Directions"><TextParagraphs value={details.access.directions} /></Field>}
            {hasText(details.access.address) && <Field label="Address"><TextParagraphs value={details.access.address} /></Field>}
            {hasText(details.access.transportNotes) && <Field label="Transport"><TextParagraphs value={details.access.transportNotes} /></Field>}
            {details.access.entryPoints?.length ? <Field label="Entry points"><ul className={styles.entryPoints}>{details.access.entryPoints.map((entry, index) => <li key={`${entry.latitude},${entry.longitude}-${index}`}>
              {entry.name && <strong>{entry.name}</strong>}
              <span>{entry.latitude}, {entry.longitude}</span>
            </li>)}</ul></Field> : null}
          </dl>
        </Disclosure>}
        {hasActivities && <Disclosure title="Activities"><NameDetailList items={details.activities!} /></Disclosure>}
        {hasFacilities && <Disclosure title="Facilities">
          <ul className={styles.nameList}>{details.facilities!.map((facility, index) => <li key={`${facility.name}-${index}`}>
            <strong>{facility.name}</strong>
            {facility.details && <TextParagraphs value={facility.details} />}
            {facility.availability && <p className={styles.availability}>Availability: {facility.availability === "unspecified" ? "Not specified" : facility.availability}</p>}
          </li>)}</ul>
        </Disclosure>}
        {hasTrailsOrMaps && <Disclosure title="Trails and maps">
          {details.trails?.length ? <ul className={styles.nameList}>{details.trails.map((trail, index) => <li key={`${trail.name}-${index}`}>
            <strong>{trail.name}</strong>
            {trail.description && <TextParagraphs value={trail.description} />}
            <dl className={styles.inlineFacts}>
              {trail.lengthKm !== null && <Field label="Length">{trail.lengthKm} km</Field>}
              {trail.elevationGainM !== null && <Field label="Elevation gain">{trail.elevationGainM} m</Field>}
              {trail.difficulty && <Field label="Difficulty">{trail.difficulty}</Field>}
            </dl>
            {safeHttpUrl(trail.mapUrl) && safeExternalLink(safeHttpUrl(trail.mapUrl), "Trail map", styles.contentLink)}
          </li>)}</ul> : null}
          {details.maps?.some((map) => map.title || map.url || map.kind) && <ul className={styles.nameList}>{details.maps.filter((map) => map.title || map.url || map.kind).map((map, index) => {
            const label = map.title || (map.kind ? `${map.kind[0].toLocaleUpperCase()}${map.kind.slice(1)} map` : "Map");
            const href = safeHttpUrl(map.url);
            return <li key={`${label}-${index}`}>{safeExternalLink(href, label, styles.contentLink)}{map.title && map.kind && <span className={styles.secondaryText}> · {map.kind}</span>}</li>;
          })}</ul>}
          {hasText(details.mapNotes) && <TextParagraphs value={details.mapNotes} />}
        </Disclosure>}
        {hasOperations && <Disclosure title="Hours and seasons">
          <dl className={styles.fields}>
            {hasText(details.operations.hours) && <Field label="Hours"><TextParagraphs value={details.operations.hours} /></Field>}
            {hasText(details.operations.seasons) && <Field label="Seasons"><TextParagraphs value={details.operations.seasons} /></Field>}
            {hasText(details.operations.notes) && <Field label="Operations"><TextParagraphs value={details.operations.notes} /></Field>}
            {safeHttpUrl(details.officialUpdatesUrl) && <Field label="Updates">{safeExternalLink(safeHttpUrl(details.officialUpdatesUrl), "Official updates", styles.contentLink)}</Field>}
          </dl>
        </Disclosure>}
        {hasRules && <Disclosure title="Rules">
          <dl className={styles.fields}>
            {hasText(details.rules.pets) && <Field label="Pets"><TextParagraphs value={details.rules.pets} /></Field>}
            {hasText(details.rules.cycling) && <Field label="Cycling"><TextParagraphs value={details.rules.cycling} /></Field>}
            {hasText(details.rules.campfires) && <Field label="Campfires"><TextParagraphs value={details.rules.campfires} /></Field>}
            {details.rules.other?.length ? <Field label="Other rules"><NameDetailList items={details.rules.other} /></Field> : null}
          </dl>
        </Disclosure>}
        {hasCamping && <Disclosure title="Camping">
          <dl className={styles.fields}>
            {hasText(details.camping.summary) && <Field label="Camping"><TextParagraphs value={details.camping.summary} /></Field>}
            {details.camping.reservationRequired !== null && <Field label="Reservations">{details.camping.reservationRequired ? "Required" : "Not required"}</Field>}
            {safeHttpUrl(details.camping.bookingUrl) && <Field label="Booking">{safeExternalLink(safeHttpUrl(details.camping.bookingUrl), "Visit booking page", styles.contentLink)}</Field>}
            {hasText(details.camping.reservationNotes) && <Field label="Reservation notes"><TextParagraphs value={details.camping.reservationNotes} /></Field>}
            {hasText(details.camping.fees) && <Field label="Fees"><TextParagraphs value={details.camping.fees} /></Field>}
          </dl>
        </Disclosure>}
        {hasAccessibility && <Disclosure title="Accessibility">
          {hasText(details.accessibility.summary) && <TextParagraphs value={details.accessibility.summary} />}
          {details.accessibility.features?.length ? <NameDetailList items={details.accessibility.features} /> : null}
        </Disclosure>}
        {visibleContacts.length > 0 && <Disclosure title="Contacts">
          <ul className={styles.nameList}>{visibleContacts.map((contact, index) => <li key={`${contact.name || contact.role || "contact"}-${index}`}>
            {contact.name && <strong>{contact.name}</strong>}
            {contact.role && <p>{contact.role}</p>}
            {contact.phone && <p>{safeContactLink(safeTelephoneHref(contact.phone), contact.phone, styles.contentLink)}</p>}
            {contact.email && <p>{safeContactLink(safeEmailHref(contact.email), contact.email, styles.contentLink)}</p>}
            {contact.url && <p>{safeExternalLink(safeHttpUrl(contact.url), contact.url, styles.contentLink)}</p>}
          </li>)}</ul>
        </Disclosure>}
        {hasBackground && <Disclosure title="History and nature">
          <dl className={styles.fields}>
            {hasText(details.background.history) && <Field label="History"><TextParagraphs value={details.background.history} /></Field>}
            {hasText(details.background.conservation) && <Field label="Conservation"><TextParagraphs value={details.background.conservation} /></Field>}
            {hasText(details.background.culturalContext) && <Field label="Cultural context"><TextParagraphs value={details.background.culturalContext} /></Field>}
            {hasText(details.background.wildlife) && <Field label="Wildlife"><TextParagraphs value={details.background.wildlife} /></Field>}
          </dl>
        </Disclosure>}
      </div>}
    </section>
  </>;
}

export { makeOverviewLead };
