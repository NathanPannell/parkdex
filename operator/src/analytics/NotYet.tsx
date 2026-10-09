import { Icon } from "../ui";

/** In place of a chart or tile whose tables a database a release behind does not have yet. */
export function NotYet({ notes }: { notes: string[] }) {
  return (
    <div className="an-not-yet" role="note">
      <Icon name="clock" size={18} />
      <div>
        <strong>Not in this database yet</strong>
        {notes.length > 0 && <span className="muted an-small">{notes.join(", ")}. It appears once the migration ships here.</span>}
      </div>
    </div>
  );
}
