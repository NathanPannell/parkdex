import { useState } from "react";
import { Icon, useToast } from "../ui";

/** Commands to run on the operator's machine, one per line, with a copy button. */
export function Commands({ lines, label = "Commands" }: { lines: string[]; label?: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.show("Copy is blocked here; select the text instead.", { tone: "error" });
    }
  }
  return (
    <div className="commands">
      <pre aria-label={label}>
        <code>{lines.join("\n")}</code>
      </pre>
      <button
        type="button"
        className="icon-button icon-button--small commands__copy"
        onClick={() => void copy()}
        aria-label={`Copy ${label.toLowerCase()}`}
        title="Copy"
      >
        <Icon name={copied ? "check" : "download"} size={15} />
      </button>
    </div>
  );
}

/** A short hash that copies in full on click. */
export function Hash({ value, length = 10 }: { value: string | null | undefined; length?: number }) {
  const toast = useToast();
  if (!value) return <span className="muted">—</span>;
  return (
    <button
      type="button"
      className="hash"
      title={`${value} (click to copy)`}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => toast.show("Copied"))
          .catch(() => undefined);
      }}
    >
      {value.slice(0, length)}
    </button>
  );
}
