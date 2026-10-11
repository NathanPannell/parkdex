// The photo lab dashboard. Decisions come from the production decidePhoto through evaluate.ts,
// recomputed in the browser from the saved probabilities whenever a threshold moves.
import { CATEGORIES, decideLab, exportSettings, productionSettings, summarize, yesProbability } from "/modules/tools/photo-lab/evaluate.ts";
import { PHOTO_FLAGS } from "/modules/worker/founderPhoto.ts";

const COST_PER_PHOTO = 0.00023;
const FLAG_NAMES = {
  people: "People", lighting: "Dark or blurry", not_park: "Not a park", inappropriate: "Inappropriate",
  not_photo: "Not a photo", personal_info: "Personal info",
};
const STORE_KEY = "photo-lab:settings";

const state = {
  manifest: null,
  runs: [],
  run: null,
  compare: null,
  settings: loadSettings(),
  selected: new Set(),
  cell: null,
  cards: new Map(),
  evaluations: new Map(),
  compareEvaluations: new Map(),
};

const $ = (id) => document.getElementById(id);

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
    if (saved && typeof saved.approve === "number" && saved.flags) return { ...productionSettings(), ...saved, flags: { ...productionSettings().flags, ...saved.flags } };
  } catch {
    // Storage can be unavailable; the production thresholds are a fine start.
  }
  return productionSettings();
}

function saveSettings() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.settings));
  } catch {
    // Not saved; the page still works.
  }
}

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child);
  return node;
}

const fmt = (value) => (value === null || value === undefined ? "n/a" : value.toFixed(2));
const pct = (value) => (value === null || value === undefined ? "n/a" : `${Math.round(value * 100)}%`);

async function getJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function runLabel(run) {
  const when = new Date(run.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `${when} · ${run.label}`;
}

// Threshold controls -------------------------------------------------------------------------

function bindPair(rangeId, numberId, read, write) {
  const range = $(rangeId);
  const number = $(numberId);
  const sync = () => {
    range.value = read();
    number.value = read().toFixed(2);
  };
  const update = (value) => {
    const parsed = Math.min(1, Math.max(0, Number(value)));
    if (!Number.isFinite(parsed)) return;
    write(Math.round(parsed * 100) / 100);
    saveSettings();
    refreshControls();
    recompute();
  };
  range.addEventListener("input", () => update(range.value));
  number.addEventListener("change", () => update(number.value));
  return sync;
}

const syncers = [];

function buildControls() {
  const container = $("flag-controls");
  for (const flag of PHOTO_FLAGS) {
    container.append(el("div", { class: "control", "data-flag": flag },
      el("div", { class: "control-head" },
        el("label", { for: `t-${flag}`, text: FLAG_NAMES[flag] }),
        el("input", { type: "number", id: `n-${flag}`, min: 0, max: 1, step: 0.01 })),
      el("input", { type: "range", id: `t-${flag}`, min: 0, max: 1, step: 0.01 })));
    syncers.push(bindPair(`t-${flag}`, `n-${flag}`, () => state.settings.flags[flag], (value) => { state.settings.flags[flag] = value; }));
  }
  syncers.push(bindPair("t-approve", "n-approve", () => state.settings.approve, (value) => { state.settings.approve = value; }));
  syncers.push(bindPair("t-reject-verdict", "n-reject-verdict", () => state.settings.rejectVerdict, (value) => { state.settings.rejectVerdict = value; }));
  syncers.push(bindPair("t-all", "n-all", () => {
    const values = PHOTO_FLAGS.map((flag) => state.settings.flags[flag]);
    return values.reduce((a, b) => a + b, 0) / values.length;
  }, (value) => { for (const flag of PHOTO_FLAGS) state.settings.flags[flag] = value; }));
  $("unsure-mode").addEventListener("change", (event) => {
    state.settings.unsureMode = event.target.value;
    saveSettings();
    refreshControls();
    recompute();
  });
  $("reset").addEventListener("click", () => {
    state.settings = productionSettings();
    saveSettings();
    refreshControls();
    recompute();
  });
  $("export").addEventListener("click", () => {
    const { json, code } = exportSettings(state.settings);
    $("export-json").textContent = json;
    $("export-code").textContent = code;
    $("export-dialog").showModal();
  });
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText($(button.dataset.copy).textContent);
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = button.dataset.copy === "export-json" ? "Copy JSON" : "Copy code"; }, 1200);
    });
  }
}

function refreshControls() {
  for (const sync of syncers) sync();
  const production = productionSettings();
  $("unsure-mode").value = state.settings.unsureMode;
  $("reject-verdict-wrap").hidden = state.settings.unsureMode !== "reject_verdict";
  document.querySelector('[data-key="approve"]').classList.toggle("changed", state.settings.approve !== production.approve);
  for (const flag of PHOTO_FLAGS) {
    document.querySelector(`[data-flag="${flag}"]`).classList.toggle("changed", state.settings.flags[flag] !== production.flags[flag]);
  }
}

// Cards --------------------------------------------------------------------------------------

function chip(kind, text) {
  return el("span", { class: `chip ${kind}`, text });
}

function buildCards() {
  const grid = $("grid");
  grid.replaceChildren();
  state.cards.clear();
  for (const photo of state.manifest.photos) {
    const checkbox = el("input", { type: "checkbox", "aria-label": `Select ${photo.id}` });
    checkbox.checked = state.selected.has(photo.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selected.add(photo.id);
      else state.selected.delete(photo.id);
      card.classList.toggle("selected", checkbox.checked);
      updateSelection();
    });
    const expected = photo.expected;
    const decisionLine = el("div", { class: "line" });
    const compareLine = el("div", { class: "compare-line", hidden: true });
    const verdictStack = el("div", { class: "stack" });
    const verdictLegend = el("div", { class: "legend" });
    const bars = el("div", { class: "bars" });
    const flagRows = new Map();
    for (const flag of PHOTO_FLAGS) {
      const fill = el("div", { class: "fill" });
      const tick = el("div", { class: "tick" });
      const value = el("span", { class: "value" });
      const nameClass = expected.flags.includes(flag) ? "name expected" : expected.optionalFlags.includes(flag) ? "name optional" : "name";
      const title = expected.flags.includes(flag) ? "Expected" : expected.optionalFlags.includes(flag) ? "Optional: not scored" : "Not expected";
      bars.append(el("div", { class: "bar-row", title: `${FLAG_NAMES[flag]} (${title})` },
        el("span", { class: nameClass, text: FLAG_NAMES[flag] }), el("div", { class: "track" }, fill, tick), value));
      flagRows.set(flag, { fill, tick, value });
    }
    const card = el("article", { class: "card", "data-id": photo.id },
      el("a", { class: "thumb", href: `/images/${photo.id}.jpg`, target: "_blank", rel: "noopener", title: "Open the full image" },
        el("img", { src: `/images/${photo.id}.jpg`, alt: photo.description, loading: "lazy" })),
      el("label", { class: "select" }, checkbox),
      el("div", { class: "body" },
        el("div", { class: "title" }, el("strong", { text: photo.id }), el("span", { class: "subtle", text: photo.category.replace("_", " ") })),
        el("p", { class: "desc", text: photo.description }),
        el("div", { class: "line" }, el("span", { class: "key", text: "Expected" }),
          chip(expected.outcome, expected.outcome), ...expected.flags.map((flag) => chip("", FLAG_NAMES[flag]))),
        decisionLine,
        compareLine,
        el("div", { class: "verdict" }, verdictStack, verdictLegend),
        bars));
    card.classList.toggle("selected", state.selected.has(photo.id));
    grid.append(card);
    state.cards.set(photo.id, { card, decisionLine, compareLine, verdictStack, verdictLegend, flagRows });
  }
}

function describe(decision) {
  if (!decision) return [chip("error", "no answer")];
  return [chip(decision.outcome, decision.outcome), ...decision.flags.map((flag) => chip("", FLAG_NAMES[flag]))];
}

function updateCards() {
  const settings = state.settings;
  for (const photo of state.manifest.photos) {
    const view = state.cards.get(photo.id);
    const evaluation = state.evaluations.get(photo.id);
    const answers = state.run?.results[photo.id]?.answers ?? null;
    view.card.classList.remove("agree", "disagree", "safe");
    if (evaluation && evaluation.agreement !== "error") view.card.classList.add(evaluation.agreement);
    const match = !evaluation || evaluation.agreement === "error" ? null
      : evaluation.agreement === "agree" ? chip("approve", "agrees") : evaluation.agreement === "safe" ? chip("unsure", "blocked, unsure") : chip("reject", "disagrees");
    view.decisionLine.replaceChildren(el("span", { class: "key", text: "Decided" }), ...describe(evaluation?.decision ?? null), match);
    const before = state.compareEvaluations.get(photo.id);
    if (state.compare && before) {
      const changed = (before.decision?.outcome ?? "error") !== (evaluation?.decision?.outcome ?? "error");
      view.compareLine.hidden = false;
      view.compareLine.classList.toggle("changed", changed);
      view.compareLine.textContent = `Comparison run: ${before.decision?.outcome ?? "no answer"}${changed ? " (changed)" : ""}`;
    } else {
      view.compareLine.hidden = true;
    }
    if (!answers) {
      view.verdictStack.replaceChildren();
      view.verdictLegend.textContent = state.run?.results[photo.id]?.error ?? "Not in this run";
      for (const row of view.flagRows.values()) {
        row.fill.style.width = "0";
        row.value.textContent = "";
      }
      continue;
    }
    const verdict = answers.verdict?.probabilities ?? {};
    const tick = el("div", { class: "tick", title: `Approve threshold ${settings.approve.toFixed(2)}` });
    tick.style.left = `${settings.approve * 100}%`;
    const parts = ["approve", "reject", "unsure"].map((label) => {
      const part = el("span", { class: `s-${label}`, title: `${label} ${fmt(verdict[label] ?? 0)}` });
      part.style.width = `${(verdict[label] ?? 0) * 100}%`;
      return part;
    });
    view.verdictStack.replaceChildren(...parts, tick);
    view.verdictLegend.textContent = `approve ${fmt(verdict.approve ?? 0)} · reject ${fmt(verdict.reject ?? 0)} · unsure ${fmt(verdict.unsure ?? 0)}`;
    for (const flag of PHOTO_FLAGS) {
      const row = view.flagRows.get(flag);
      const p = yesProbability(answers, flag);
      row.fill.style.width = `${p * 100}%`;
      row.fill.classList.toggle("over", p > settings.flags[flag]);
      row.tick.style.left = `${settings.flags[flag] * 100}%`;
      row.value.textContent = fmt(p);
    }
  }
}

// Summary ------------------------------------------------------------------------------------

function tile(label, value, detail, kind, delta) {
  return el("div", { class: `tile ${kind ?? ""}` },
    el("div", { class: "label", text: label }),
    el("div", { class: "value" }, value, delta ?? null),
    detail ? el("div", { class: "detail", text: detail }) : null);
}

function deltaNode(now, before, higherIsBetter, format) {
  if (before === null || before === undefined || now === null || now === undefined) return null;
  const diff = now - before;
  if (Math.abs(diff) < 1e-9) return el("span", { class: "delta", text: "same" });
  const better = higherIsBetter ? diff > 0 : diff < 0;
  return el("span", { class: `delta ${better ? "better" : "worse"}`, text: `${diff > 0 ? "+" : ""}${format(diff)} vs comparison` });
}

function renderSummary(summary, compareSummary) {
  const c = compareSummary;
  $("tiles").replaceChildren(
    tile("Accuracy", pct(summary.accuracy), `${summary.correct} of ${summary.scored} approve or reject labels`, "",
      c ? deltaNode(summary.accuracy, c.accuracy, true, (d) => `${Math.round(d * 100)} pts`) : null),
    tile("False approvals", String(summary.falseApprovals.length), "bad photos approved", summary.falseApprovals.length ? "danger" : "",
      c ? deltaNode(summary.falseApprovals.length, c.falseApprovals.length, false, String) : null),
    tile("False rejections", String(summary.falseRejections.length), `of ${summary.goodTotal} good photos`, summary.falseRejections.length ? "warn" : "",
      c ? deltaNode(summary.falseRejections.length, c.falseRejections.length, false, String) : null),
    tile("Bad photos blocked", `${summary.badBlocked}/${summary.badTotal}`, `${summary.rejectedBad} rejected, ${summary.badBlocked - summary.rejectedBad} unsure`),
    tile("Right reason", `${summary.rightReason}/${summary.rejectedBad}`, "rejections naming an expected flag"),
    tile("No answer", String(summary.errors), state.run ? `${state.run.model}` : ""),
  );

  const rows = ["approve", "reject", "either"];
  const cols = ["approve", "reject", "unsure"];
  const table = $("confusion");
  table.replaceChildren(el("tr", {}, el("th", { text: "Expected ↓ / decided →" }), ...cols.map((col) => el("th", { text: col }))));
  for (const row of rows) {
    table.append(el("tr", {}, el("th", { text: row }), ...cols.map((col) => {
      const kind = row === "either" ? "" : row === col ? "hit" : row === "reject" && col === "unsure" ? "soft" : "miss";
      const active = state.cell && state.cell.expected === row && state.cell.decided === col;
      return el("td", {
        class: `cell ${summary.confusion[row][col] ? kind : ""} ${active ? "active" : ""}`, text: String(summary.confusion[row][col]),
        onclick: () => {
          state.cell = active ? null : { expected: row, decided: col };
          recompute();
        },
      });
    })));
  }

  const flagTable = $("flag-table");
  flagTable.replaceChildren(el("tr", {}, ...["Flag", "Above", "TP", "FP", "FN", "Precision", "Recall"].map((text) => el("th", { text }))));
  for (const score of summary.flags) {
    flagTable.append(el("tr", { title: score.covered ? "" : "Not covered by the dataset" },
      el("td", { text: `${FLAG_NAMES[score.flag]}${score.covered ? "" : " (not covered)"}` }),
      el("td", { text: state.settings.flags[score.flag].toFixed(2) }),
      el("td", { text: String(score.truePositive) }), el("td", { text: String(score.falsePositive) }), el("td", { text: String(score.falseNegative) }),
      el("td", { class: score.precision === null ? "na" : "", text: pct(score.precision) }),
      el("td", { class: score.recall === null ? "na" : "", text: pct(score.recall) })));
  }

  const listChips = (ids) => ids.length
    ? ids.map((id) => el("button", { type: "button", class: "chip", text: id, onclick: () => scrollToCard(id) }))
    : [el("span", { class: "empty", text: "None" })];
  $("false-approvals").replaceChildren(...listChips(summary.falseApprovals));
  $("false-rejections").replaceChildren(...listChips(summary.falseRejections));
}

function scrollToCard(id) {
  const view = state.cards.get(id);
  if (!view) return;
  if (view.card.classList.contains("hidden")) {
    $("f-category").value = "all";
    $("f-agreement").value = "all";
    state.cell = null;
    recompute();
  }
  view.card.scrollIntoView({ behavior: "smooth", block: "center" });
  view.card.animate([{ boxShadow: "0 0 0 3px var(--accent)" }, { boxShadow: "none" }], { duration: 1400 });
}

// Filters ------------------------------------------------------------------------------------

function visibleIds() {
  const category = $("f-category").value;
  const agreement = $("f-agreement").value;
  return state.manifest.photos.filter((photo) => {
    const evaluation = state.evaluations.get(photo.id);
    if (category !== "all" && photo.category !== category) return false;
    if (state.cell && (photo.expected.outcome !== state.cell.expected || evaluation?.decision?.outcome !== state.cell.decided)) return false;
    switch (agreement) {
      case "agree": return evaluation?.agreement === "agree";
      case "disagree": return evaluation?.agreement === "disagree";
      case "safe": return evaluation?.agreement === "safe";
      case "false-approval": return Boolean(evaluation?.falseApproval);
      case "false-rejection": return Boolean(evaluation?.falseRejection);
      case "error": return evaluation?.agreement === "error";
      case "changed": {
        const before = state.compareEvaluations.get(photo.id);
        return Boolean(state.compare && before && (before.decision?.outcome ?? "error") !== (evaluation?.decision?.outcome ?? "error"));
      }
      default: return true;
    }
  }).map((photo) => photo.id);
}

function applyFilters() {
  const shown = new Set(visibleIds());
  for (const [id, view] of state.cards) view.card.classList.toggle("hidden", !shown.has(id));
  $("shown").textContent = `${shown.size} of ${state.manifest.photos.length} shown`;
  $("rerun-filtered").textContent = `Rerun shown (${shown.size})`;
  const cellFilter = $("cell-filter");
  cellFilter.hidden = !state.cell;
  if (state.cell) {
    cellFilter.replaceChildren(`Expected ${state.cell.expected}, decided ${state.cell.decided}`,
      el("button", { type: "button", text: "x", "aria-label": "Clear cell filter", onclick: () => { state.cell = null; recompute(); } }));
  }
  return shown;
}

function updateSelection() {
  $("rerun-selected").disabled = state.selected.size === 0 || !state.run;
  $("rerun-selected").textContent = `Rerun selected (${state.selected.size})`;
}

// Runs ---------------------------------------------------------------------------------------

function recompute() {
  if (!state.manifest) return;
  const empty = { results: {} };
  const { photos, summary } = summarize(state.manifest, state.run ?? empty, state.settings);
  state.evaluations = new Map(photos.map((evaluation) => [evaluation.id, evaluation]));
  let compareSummary = null;
  state.compareEvaluations = new Map();
  if (state.compare) {
    const compared = summarize(state.manifest, state.compare, state.settings);
    state.compareEvaluations = new Map(compared.photos.map((evaluation) => [evaluation.id, evaluation]));
    compareSummary = compared.summary;
  }
  renderSummary(summary, compareSummary);
  updateCards();
  applyFilters();
}

function fillRunSelects() {
  const runSelect = $("run");
  const compareSelect = $("compare");
  runSelect.replaceChildren(...state.runs.map((run) => el("option", { value: run.id, text: runLabel(run) })));
  compareSelect.replaceChildren(el("option", { value: "", text: "Nothing" }), ...state.runs.map((run) => el("option", { value: run.id, text: runLabel(run) })));
  if (state.run) runSelect.value = state.run.id;
  compareSelect.value = state.compare?.id ?? "";
}

function showRunInfo() {
  const run = state.run;
  if (!run) {
    $("model").textContent = "No runs yet. Use Rerun all to classify the photos.";
    return;
  }
  const spend = run.spend.reportedCostUsd;
  $("model").textContent = `${run.model} · ${run.queried.length} queried · $${spend.toFixed(4)} reported · park context "${run.context.parkName}"`;
}

async function selectRun(id, compareId) {
  state.run = id ? await getJson(`/api/runs/${id}`) : null;
  if (compareId !== undefined) state.compare = compareId ? await getJson(`/api/runs/${compareId}`) : null;
  if (state.compare && state.compare.id === state.run?.id) state.compare = null;
  if (state.compare && state.run && state.compare.questionsSha256 !== state.run.questionsSha256) {
    $("model").title = "The comparison run used different question wording.";
  }
  fillRunSelects();
  showRunInfo();
  updateSelection();
  recompute();
}

async function loadRuns() {
  state.runs = await getJson("/api/runs");
}

async function startRerun(ids) {
  if (!state.run && ids) return;
  const count = ids?.length ?? state.manifest.photos.length;
  if (!count) return;
  const estimate = (count * COST_PER_PHOTO).toFixed(4);
  if (!confirm(`Query the Decisions API for ${count} photo${count === 1 ? "" : "s"}? About $${estimate}.`)) return;
  const label = prompt("Label for this run", ids ? `Rerun of ${count} photos` : `All ${count} photos`) ?? undefined;
  try {
    await getJson("/api/rerun", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ids ?? null, basedOn: ids ? state.run.id : null, label }),
    });
    pollJob(state.run?.id ?? null);
  } catch (error) {
    alert(error.message);
  }
}

async function pollJob(previousRunId) {
  setRerunEnabled(false);
  $("progress").hidden = false;
  for (;;) {
    const { job } = await getJson("/api/status");
    if (!job) break;
    $("progress-fill").style.width = `${job.total ? (job.done / job.total) * 100 : 0}%`;
    $("progress-text").textContent = `${job.done}/${job.total}${job.failed ? `, ${job.failed} failed` : ""}`;
    if (!job.running) {
      if (job.error) alert(`The run failed: ${job.error}`);
      if (job.runId) {
        await loadRuns();
        await selectRun(job.runId, previousRunId ?? "");
      }
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  setTimeout(() => { $("progress").hidden = true; }, 1500);
  setRerunEnabled(true);
}

function setRerunEnabled(enabled) {
  $("rerun-all").disabled = !enabled;
  $("rerun-filtered").disabled = !enabled || !state.run;
  $("rerun-selected").disabled = !enabled || !state.run || state.selected.size === 0;
}

// Start --------------------------------------------------------------------------------------

async function main() {
  buildControls();
  refreshControls();
  state.manifest = await getJson("/api/manifest");
  $("f-category").replaceChildren(el("option", { value: "all", text: "All" }),
    ...CATEGORIES.map((category) => {
      const count = state.manifest.photos.filter((photo) => photo.category === category).length;
      return el("option", { value: category, text: `${category.replace("_", " ")} (${count})` });
    }));
  $("f-category").addEventListener("change", applyFilters);
  $("f-agreement").addEventListener("change", applyFilters);
  $("run").addEventListener("change", (event) => selectRun(event.target.value));
  $("compare").addEventListener("change", (event) => selectRun(state.run?.id, event.target.value));
  $("rerun-all").addEventListener("click", () => startRerun(null));
  $("rerun-filtered").addEventListener("click", () => {
    const ids = visibleIds();
    startRerun(ids.length === state.manifest.photos.length ? null : ids);
  });
  $("rerun-selected").addEventListener("click", () => startRerun([...state.selected]));
  $("select-shown").addEventListener("click", () => {
    for (const id of visibleIds()) state.selected.add(id);
    for (const [id, view] of state.cards) {
      view.card.classList.toggle("selected", state.selected.has(id));
      view.card.querySelector("input[type=checkbox]").checked = state.selected.has(id);
    }
    updateSelection();
  });
  $("select-none").addEventListener("click", () => {
    state.selected.clear();
    for (const view of state.cards.values()) {
      view.card.classList.remove("selected");
      view.card.querySelector("input[type=checkbox]").checked = false;
    }
    updateSelection();
  });
  buildCards();
  await loadRuns();
  await selectRun(state.runs[0]?.id ?? null, state.runs[1]?.id ?? "");
  setRerunEnabled(true);
  const { job, hasKey } = await getJson("/api/status");
  if (!hasKey) $("model").textContent += " · OPENROUTER_API_KEY is not set, so reruns are off";
  if (!hasKey) $("rerun-all").disabled = true;
  if (job?.running) pollJob(state.run?.id ?? null);
}

main().catch((error) => {
  document.body.prepend(el("p", { class: "chip reject", text: `The lab could not start: ${error.message}` }));
});
