import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "../api";
import { Card, fullDate, Icon, Notice, PageHeader, Table, timeAgo, useToast, type Column } from "../ui";
import { ChannelCard } from "./ChannelCard";
import { Commands, Hash } from "./Commands";
import { MoveDrawer, type MoveTarget } from "./MoveDrawer";
import { ACTION_LABEL, CHANNEL_NAME, megabytes, nextApplyCommand, OUTCOME_LABEL } from "./otaText";
import { SetupChecklist } from "./SetupChecklist";
import "./updates.css";
import type { BundleView, Channel, OtaPublish, SetupItem, UpdatesOverview } from "./types";

/**
 * /app/updates: over-the-air web bundles. Each channel's live pointer and what installed builds
 * do with it, the bundles in R2, the publish history, moving a channel to a bundle already in R2,
 * and the commands for publishing a new one.
 */
export function UpdatesPage() {
  const toast = useToast();
  const [overview, setOverview] = useState<UpdatesOverview | null>(null);
  const [error, setError] = useState("");
  const [setup, setSetup] = useState<SetupItem[] | null>(null);
  const [setupError, setSetupError] = useState("");
  const [revision, setRevision] = useState(0);
  const [target, setTarget] = useState<MoveTarget | null>(null);

  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<UpdatesOverview>("/api/app/updates", { signal: controller.signal })
      .then(setOverview)
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorText(reason, "Could not load the update channels.")); });
    setSetupError("");
    setSetup(null);
    api<{ items: SetupItem[] }>("/api/app/updates/setup", { signal: controller.signal })
      .then(({ items }) => setSetup(items))
      .catch((reason: unknown) => { if (!controller.signal.aborted) setSetupError(errorText(reason, "Could not run the setup checks.")); });
    return () => controller.abort();
  }, [revision]);

  const canMove = Boolean(overview?.cloudflare.configured && !overview.cloudflare.error && overview.bundles?.length);
  const staging = overview?.channels.find((view) => view.channel === "staging");

  const bundleColumns: Column<BundleView>[] = [
    { key: "version", header: "Bundle", cell: (bundle) => <div className="cell-stack"><strong className="mono">{bundle.version ?? "Unrecorded"}</strong><Hash value={bundle.sha256} length={12} /></div> },
    { key: "commit", header: "Commit", width: "100px", cell: (bundle) => <Hash value={bundle.sourceCommit} length={7} /> },
    { key: "size", header: "Size", width: "90px", align: "right", cell: (bundle) => megabytes(bundle.byteSize) },
    { key: "uploaded", header: "Uploaded", width: "120px", cell: (bundle) => bundle.uploadedAt ? <span title={fullDate(bundle.uploadedAt)}>{timeAgo(bundle.uploadedAt)}</span> : "—" },
    { key: "builds", header: "Native builds", width: "130px", cell: (bundle) => bundle.minimumNativeBuild === null ? <span className="muted" title="No publish record says which builds it needs">Unknown</span> : `${bundle.minimumNativeBuild}${bundle.maximumNativeBuild && bundle.maximumNativeBuild !== bundle.minimumNativeBuild ? ` to ${bundle.maximumNativeBuild}` : ""}` },
    { key: "live", header: "Live on", width: "170px", cell: (bundle) => bundle.liveOn.length ? <span className="tag-row">{bundle.liveOn.map((channel) => <span key={channel} className={`live-tag live-tag--${channel}`}>{CHANNEL_NAME[channel]}</span>)}</span> : <span className="muted">—</span> },
    {
      key: "actions", header: <span className="sr-only">Actions</span>, width: "250px", align: "right",
      cell: (bundle) => (
        <span className="row-actions">
          {(["staging", "production"] as Channel[]).map((channel) => (
            <button key={channel} type="button" className="button button--ghost button--small" disabled={!canMove || bundle.liveOn.includes(channel) || bundle.minimumNativeBuild === null}
              onClick={() => setTarget({ channel, sha256: bundle.sha256 })}
              title={bundle.minimumNativeBuild === null ? "Unrecorded bundles cannot be repointed" : bundle.liveOn.includes(channel) ? `Already live on ${channel}` : undefined}>
              Use on {channel}
            </button>
          ))}
        </span>
      ),
    },
  ];

  const historyColumns: Column<OtaPublish>[] = [
    { key: "when", header: "When", width: "120px", cell: (row) => <span title={fullDate(row.recordedAt)}>{timeAgo(row.recordedAt)}</span> },
    { key: "channel", header: "Channel", width: "110px", cell: (row) => <span className={`live-tag live-tag--${row.channel}`}>{CHANNEL_NAME[row.channel]}</span> },
    { key: "action", header: "Change", width: "120px", cell: (row) => <span className={`action-tag action-tag--${row.action}`}>{ACTION_LABEL[row.action]}</span> },
    { key: "version", header: "Version", cell: (row) => <div className="cell-stack"><strong className="mono">{row.version}</strong>{row.note && <span className="muted history-note">{row.note}</span>}</div> },
    { key: "generation", header: "Generation", width: "110px", cell: (row) => <span className="mono">{row.previousGeneration ?? "?"} → {row.generation}</span> },
    { key: "builds", header: "Native builds", width: "120px", cell: (row) => row.minimumNativeBuild === row.maximumNativeBuild ? String(row.minimumNativeBuild) : `${row.minimumNativeBuild} to ${row.maximumNativeBuild}` },
    { key: "source", header: "By", width: "100px", cell: (row) => row.source === "script" ? "Script" : "Dashboard" },
    { key: "outcome", header: "Readback", width: "120px", cell: (row) => <span className={`outcome outcome--${row.outcome}`}>{OUTCOME_LABEL[row.outcome]}</span> },
  ];

  return (
    <section className="page updates" aria-labelledby="updates-title">
      <PageHeader
        id="updates-title"
        eyebrow="Over-the-air updates · production only"
        title="Updates"
        lede="Which web bundle each channel's Android builds download without a Play release, and a way to roll back or promote one. Native code, plugins and permissions still need Play."
        actions={<button type="button" className="icon-button" onClick={reload} aria-label="Refresh updates" title="Refresh"><Icon name="refresh" /></button>}
      />

      {error && <Notice tone="error" action={<button type="button" className="text-button" onClick={reload}>Try again</button>}>{error}</Notice>}

      <SetupChecklist items={setup} error={setupError} onRetry={reload} />

      <div className="channel-grid">
        {overview ? overview.channels.map((view) => (
          <ChannelCard
            key={view.channel}
            view={view}
            canMove={canMove}
            onMove={() => setTarget({ channel: view.channel, sha256: null })}
            onPromote={view.channel === "staging" ? () => setTarget({ channel: "production", sha256: view.pointer?.sha256 ?? null }) : undefined}
          />
        )) : !error && [0, 1].map((key) => <div key={key} className="ui-card channel channel--skeleton" aria-hidden="true" />)}
      </div>

      {overview && (
        <Card
          className="updates-card"
          title="Bundles in R2"
          subtitle={<>Every zip under <code>app-bundles/</code> in <code>{overview.bucket}</code>. A bundle is named by the SHA-256 of its bytes and never changes.</>}
          padded={false}
        >
          {!overview.cloudflare.configured
            ? <p className="card-note"><Icon name="alert" size={16} /> The bundle list and moves need <code>CLOUDFLARE_API_TOKEN</code> and <code>CLOUDFLARE_ACCOUNT_ID</code> on this deployment. See the checklist.</p>
            : overview.cloudflare.error
              ? <p className="card-note card-note--error"><Icon name="alert" size={16} /> {overview.cloudflare.error}</p>
              : <Table caption="Bundles in R2" columns={bundleColumns} rows={overview.bundles} rowKey={(bundle) => bundle.sha256}
                  empty={<>No bundles yet. The first one comes from <code>scripts/publish-app-bundle.mjs</code> below.</>} />}
        </Card>
      )}

      {overview && (
        <Card className="updates-card" title="Publish history" subtitle="Every pointer move, from this page and from the script's --record step." padded={false}>
          {overview.history.available === false
            ? <p className="card-note"><Icon name="alert" size={16} /> The history table is not in production yet (<code>app_config_003_ota_publishes.sql</code>). Moves still work but are not recorded.</p>
            : overview.history.available === null
              ? <p className="card-note card-note--error"><Icon name="alert" size={16} /> The production database could not be read, so the history is not shown. {overview.history.error}</p>
              : <Table caption="Publish history" columns={historyColumns} rows={overview.history.rows} rowKey={(row) => String(row.id)}
                  empty="Nothing published yet. Each publication and rollback will appear here." />}
        </Card>
      )}

      {overview && (
        <Card className="updates-card" title="Publish a new bundle" subtitle="Building and uploading stays on your machine, from a clean checkout at the commit you want to ship. The dry run uploads nothing.">
          <div className="publish-grid">
            {overview.channels.map((view) => {
              const generation = view.pointer && view.state !== "invalid" ? view.pointer.generation : 0;
              return (
                <div key={view.channel} className="publish-step">
                  <h3>{CHANNEL_NAME[view.channel]}</h3>
                  <p className="muted">{generation ? `Next publication is generation ${generation + 1}; the ETag is the one the CDN serves now.` : "First publication: expected generation 0."}</p>
                  <Commands
                    label={`${CHANNEL_NAME[view.channel]} publish commands`}
                    lines={[
                      `node scripts/publish-app-bundle.mjs --channel ${view.channel} --min-native-build ${view.pointer?.minimumNativeBuild ?? "<build>"}`,
                      nextApplyCommand(view.channel, generation, view.etag, view.pointer?.minimumNativeBuild ?? null),
                    ]}
                  />
                </div>
              );
            })}
          </div>
          <p className="muted publish-foot">
            --apply needs the R2 S3 keys from the loader, and --record needs <code>OTA_HISTORY_DATABASE_URL</code>. Use the oldest native build whose plugins the bundle needs as the minimum. Full steps: <code>docs/ota-updates.md</code>.
          </p>
        </Card>
      )}

      <MoveDrawer
        target={target}
        bundles={overview?.bundles ?? []}
        channels={overview?.channels ?? []}
        onClose={() => setTarget(null)}
        onStale={reload}
        onMoved={(result) => {
          setTarget(null);
          toast.show(result.message, { tone: result.outcome === "confirmed" ? "info" : "error" });
          reload();
        }}
      />
    </section>
  );
}
