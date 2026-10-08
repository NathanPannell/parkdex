import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Park proposal moderation and instant publish against real content triggers: the migration,
// the proposal store, and the draft publish transaction with the proposal's acceptance.
// Content triggers check every park, and other SQL QA in the shared database adds parks
// without boundaries, so this runs in its own throwaway kip_qa_ database.
const shared = process.env.PGDATABASE;
assert.ok(shared?.startsWith('kip_qa_') || shared === 'kip_accounts_qa', 'SQL QA requires a dedicated kip_qa_ database');
const owned = `kip_qa_proposals_${randomBytes(8).toString('hex')}`;
const admin = new pg.Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: shared });
await admin.connect();
await admin.query(`CREATE DATABASE "${owned}"`);
process.env.PGDATABASE = owned;
const { applyMigration, dbUrl, pool } = await import('./qa-postgres-adapter.mjs');
const { createNeonParkProposalStore } = await import('../worker/parkProposals.ts');
const { createSqlProposalReviewStore, neonSqlRunner, reviewProposal } = await import('../worker/proposalReview.ts');
const migration = (name) => fileURLToPath(new URL(`../database/${name}`, import.meta.url));
const log = (name) => process.stdout.write(`${name}: PASS\n`);
const osmId = 900_000_000 + Math.floor(Math.random() * 99_000_000);
const parkId = `osm-relation-${osmId}`;
const square = (lng, lat, size) => [[lng, lat], [lng + size, lat], [lng + size, lat + size], [lng, lat + size], [lng, lat]];
const FEATURE = {
  type: 'relation',
  id: osmId,
  name: 'QA Proposal Woods',
  kind: 'leisure=park',
  tags: { leisure: 'park', name: 'QA Proposal Woods' },
  areaM2: 120_000,
  // Two parts, the first with a pond, as Overpass assembles them.
  geometry: { type: 'MultiPolygon', coordinates: [[square(-123.2, 48.9, 0.004), square(-123.199, 48.901, 0.001)], [square(-123.19, 48.9, 0.001)]] },
};
const APPROVE = {
  park: { choice: 'approve', probabilities: { approve: 0.95, reject: 0.02, unsure: 0.03 } },
  name: { choice: 'match', probabilities: { match: 0.92, mismatch: 0.03, unsure: 0.05 } },
  duplicate: { choice: 'new', probabilities: { new: 0.9, duplicate: 0.05, unsure: 0.05 } },
};
const proposals = createNeonParkProposalStore(dbUrl);
const review = createSqlProposalReviewStore(neonSqlRunner(dbUrl));

function deps(answers = APPROVE) {
  let calls = 0;
  return {
    calls: () => calls,
    value: {
      store: review,
      osm: { search: async () => [], feature: async (ref) => (ref.type === FEATURE.type && ref.id === FEATURE.id ? FEATURE : null) },
      moderate: async () => {
        calls += 1;
        return { model: 'qa-model', answers };
      },
      threshold: 0.8,
      now: () => new Date(),
    },
  };
}

async function propose(name, osm, point = [-123.1985, 48.9005]) {
  const id = randomUUID();
  const proposal = { submissionId: randomUUID(), name, note: 'QA', point, outline: null, osm, context: {} };
  const result = await proposals.save({ id, payloadHash: 'a'.repeat(64), ipHash: randomUUID().replaceAll('-', '').padEnd(64, '0'), proposal });
  assert.equal(result.status, 'created');
  return { id, name, note: 'QA', point, osm, createdAt: result.proposal.createdAt };
}

const revision = async () => Number((await pool.query('SELECT revision FROM public.content_clock')).rows[0].revision);

try {
  for (const name of ['001_cloud_content.sql', 'migrations/content_001_sync.sql', 'migrations/content_002_authoring.sql', 'migrations/content_003_park_maps_link.sql',
    'migrations/park_proposals_001_init.sql', 'migrations/park_drafts_001_init.sql', 'migrations/park_drafts_002_proposals.sql']) {
    await applyMigration(migration(name));
  }
  // The moderation migration runs on every deploy, so it must apply twice cleanly.
  await applyMigration(migration('migrations/park_proposals_002_moderation.sql'));
  await applyMigration(migration('migrations/park_proposals_002_moderation.sql'));
  await pool.query("INSERT INTO public.drive_hubs (position, name, lng, lat) VALUES (0, 'Victoria', -123.36, 48.43), (1, 'Nanaimo', -123.94, 49.17) ON CONFLICT DO NOTHING");
  await assert.rejects(pool.query(
    "INSERT INTO kip_proposals.parks (id, submission_id, payload_hash, name, longitude, latitude, osm_type) VALUES ($1, $2, $3, 'x', 0, 0, 'way')",
    [randomUUID(), randomUUID(), 'b'.repeat(64)],
  ), /parks_osm_pair_check/);
  log('moderation migration is repeat-safe and keeps the OSM pair together');

  const first = await propose('QA Proposal Woods', { type: 'relation', id: osmId });
  const listed = (await proposals.list(null)).find((item) => item.id === first.id);
  assert.deepEqual(listed.osm, { type: 'relation', id: osmId });
  assert.equal(listed.decision, null);
  const before = await revision();
  const approved = deps();
  const outcome = await reviewProposal(first, approved.value);
  assert.deepEqual(outcome, { decision: 'approved', parkId, parkName: 'QA Proposal Woods' });
  const park = (await pool.query('SELECT * FROM public.parks WHERE id = $1', [parkId])).rows[0];
  assert.equal(park.name, 'QA Proposal Woods');
  assert.equal(park.scene, null);
  assert.equal(park.category, 'municipal');
  assert.equal(park.rarity, 'common');
  assert.ok(park.region.length > 0 && park.blurb.length > 0);
  const boundary = (await pool.query('SELECT feature FROM public.boundaries WHERE park_id = $1', [parkId])).rows[0].feature;
  assert.deepEqual(boundary.properties, { id: parkId, biome: park.biome });
  assert.deepEqual(boundary.geometry, FEATURE.geometry, 'every part and hole is published');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM public.park_drive WHERE park_id = $1 AND distance_km IS NULL', [parkId])).rows[0].count, 2);
  const after = await revision();
  assert.ok(after > before, 'publishing advances the content revision');
  const changes = (await pool.query('SELECT entity FROM public.content_changes WHERE entity_id = $1 AND revision > $2 ORDER BY entity', [parkId, before])).rows.map((row) => row.entity);
  assert.deepEqual([...new Set(changes)], ['boundary', 'drive', 'park']);
  const stored = (await proposals.list(null)).find((item) => item.id === first.id);
  assert.equal(stored.status, 'accepted');
  assert.equal(stored.decision, 'approved');
  assert.equal(stored.publishedParkId, parkId);
  assert.equal(stored.moderation.model, 'qa-model');
  assert.deepEqual(stored.moderation.answers, APPROVE);
  const draft = (await pool.query('SELECT status, source FROM kip_park_drafts.drafts WHERE id = $1', [parkId])).rows[0];
  assert.equal(draft.status, 'published');
  assert.equal(draft.source.proposal.id, first.id);
  assert.equal(draft.source.osm.id, osmId);
  log('an approved proposal publishes the park, its full boundary and drive rows, and is accepted');

  const retry = deps();
  assert.deepEqual(await reviewProposal(first, retry.value), outcome);
  assert.equal(retry.calls(), 0);
  assert.equal(await revision(), after, 'a retry writes no new content');
  log('retrying a published proposal is idempotent');

  const again = await propose('Same woods again', { type: 'relation', id: osmId });
  const duplicate = deps();
  assert.deepEqual(await reviewProposal(again, duplicate.value), { decision: 'pending' });
  assert.equal(duplicate.calls(), 0);
  const againStored = (await proposals.list(null)).find((item) => item.id === again.id);
  assert.equal(againStored.decision, 'rejected');
  assert.equal(againStored.status, 'new');
  log('a second proposal for a live outline waits for the operator');

  const unsure = await propose('Maybe a park', { type: 'relation', id: osmId + 1 }, [-123.209, 48.901]);
  const unsureDeps = deps({ ...APPROVE, park: { choice: 'approve', probabilities: { approve: 0.6, reject: 0.1, unsure: 0.3 } } });
  unsureDeps.value.osm.feature = async () => ({ ...FEATURE, id: osmId + 1, geometry: { type: 'MultiPolygon', coordinates: [[square(-123.21, 48.9, 0.002)]] } });
  assert.deepEqual(await reviewProposal(unsure, unsureDeps.value), { decision: 'pending' });
  const unsureStored = (await proposals.list('new')).find((item) => item.id === unsure.id);
  assert.equal(unsureStored.decision, 'unsure');
  assert.ok(unsureStored.decidedAt);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM public.parks WHERE id = $1', [`osm-relation-${osmId + 1}`])).rows[0].count, 0);
  log('unsure proposals keep their answers and publish nothing');
} finally {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS "${owned}"`);
  await admin.end();
}
