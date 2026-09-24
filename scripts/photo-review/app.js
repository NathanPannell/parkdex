"use strict";

const ui = {
  loading: document.querySelector("#loading-state"),
  error: document.querySelector("#error-state"),
  errorMessage: document.querySelector("#error-message"),
  retry: document.querySelector("#retry-button"),
  content: document.querySelector("#review-content"),
  progressLabel: document.querySelector("#progress-label"),
  progressFill: document.querySelector("#progress-fill"),
  search: document.querySelector("#place-search"),
  filters: [...document.querySelectorAll(".filter-button")],
  railCount: document.querySelector("#rail-count"),
  placeList: document.querySelector("#place-list"),
  mobilePicker: document.querySelector("#mobile-place-picker"),
  previous: document.querySelector("#previous-park"),
  next: document.querySelector("#next-park"),
  position: document.querySelector("#park-position"),
  placeName: document.querySelector("#place-name"),
  placeSummary: document.querySelector("#place-summary"),
  placeStatus: document.querySelector("#place-status"),
  grid: document.querySelector("#candidate-grid"),
  savePath: document.querySelector("#save-path"),
  toast: document.querySelector("#toast"),
};

const state = {
  candidates: [],
  places: [],
  decisions: {},
  currentPlaceId: null,
  filter: "all",
  search: "",
  pending: new Set(),
  queues: new Map(),
  toastTimer: null,
};

function statusFor(candidate) {
  return state.decisions[candidate.candidate_id]?.status || "pending";
}

function placeCounts(place) {
  const result = { approved: 0, rejected: 0, pending: 0 };
  for (const candidate of place.candidates) result[statusFor(candidate)] += 1;
  return result;
}

function filteredPlaces() {
  const term = state.search.trim().toLocaleLowerCase();
  return state.places.filter((place) => {
    if (term && !place.name.toLocaleLowerCase().includes(term)) return false;
    const counts = placeCounts(place);
    return state.filter === "all" || counts[state.filter] > 0;
  });
}

function safeUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function externalLink(label, rawUrl) {
  const url = safeUrl(rawUrl);
  if (!url) return null;
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.referrerPolicy = "no-referrer";
  link.textContent = label;
  return link;
}

function showToast(message, isError = false) {
  clearTimeout(state.toastTimer);
  ui.toast.textContent = message;
  ui.toast.classList.toggle("is-error", isError);
  ui.toast.hidden = false;
  state.toastTimer = setTimeout(() => { ui.toast.hidden = true; }, isError ? 6500 : 2300);
}

function renderProgress() {
  const reviewed = state.candidates.filter((candidate) => statusFor(candidate) !== "pending").length;
  ui.progressLabel.textContent = `${reviewed} / ${state.candidates.length} images reviewed`;
  ui.progressFill.style.transform = `scaleX(${state.candidates.length ? reviewed / state.candidates.length : 0})`;
}

function renderFilters() {
  for (const button of ui.filters) {
    const active = button.dataset.filter === state.filter;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function renderRail() {
  const places = filteredPlaces();
  ui.railCount.textContent = `${places.length} of ${state.places.length} parks shown`;
  ui.placeList.replaceChildren();
  if (!places.length) {
    const empty = document.createElement("p");
    empty.className = "rail-empty";
    empty.textContent = "No parks match this view. Change the filter or search.";
    ui.placeList.append(empty);
  }
  for (const place of places) {
    const counts = placeCounts(place);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "place-entry";
    item.classList.toggle("is-current", place.id === state.currentPlaceId);
    item.classList.toggle("is-complete", counts.pending === 0);
    item.setAttribute("aria-current", place.id === state.currentPlaceId ? "true" : "false");
    const name = document.createElement("span");
    name.className = "place-entry-name";
    name.textContent = place.name;
    const count = document.createElement("span");
    count.className = "place-entry-count";
    count.textContent = `${counts.approved + counts.rejected}/${place.candidates.length}`;
    count.setAttribute("aria-label", `${counts.approved + counts.rejected} of ${place.candidates.length} images reviewed`);
    item.append(name, count);
    item.addEventListener("click", () => setCurrentPlace(place.id));
    ui.placeList.append(item);
  }

  ui.mobilePicker.replaceChildren();
  for (const place of state.places) {
    const counts = placeCounts(place);
    const option = document.createElement("option");
    option.value = place.id;
    option.textContent = `${place.name} (${counts.approved + counts.rejected}/${place.candidates.length})`;
    ui.mobilePicker.append(option);
  }
  ui.mobilePicker.value = state.currentPlaceId || "";
}

function addMetadata(list, label, value) {
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.textContent = value || "Not supplied";
  list.append(term, detail);
}

function imageFrame(candidate, status) {
  const frame = document.createElement("div");
  frame.className = "image-frame";
  const imageUrl = safeUrl(candidate.thumbnail_url) || safeUrl(candidate.image_url);
  if (imageUrl) {
    const img = document.createElement("img");
    img.src = imageUrl;
    img.alt = `Candidate photograph for ${candidate.place_name}: ${candidate.title || "untitled"}`;
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => {
      img.remove();
      const unavailable = document.createElement("div");
      unavailable.className = "image-unavailable";
      unavailable.textContent = "Preview unavailable. Open the source page to inspect the image.";
      frame.prepend(unavailable);
    }, { once: true });
    frame.append(img);
  } else {
    const unavailable = document.createElement("div");
    unavailable.className = "image-unavailable";
    unavailable.textContent = "No secure preview URL. Open the source page to inspect the image.";
    frame.append(unavailable);
  }
  const source = document.createElement("span");
  source.className = "source-tag";
  source.textContent = candidate.source === "wikimedia_commons" ? "Wikimedia Commons" : candidate.source === "openverse" ? "Openverse" : candidate.source;
  const decision = document.createElement("span");
  decision.className = `decision-tag is-${status}`;
  decision.textContent = status === "pending" ? "Not reviewed" : status === "approved" ? "Approved" : "Rejected";
  frame.append(source, decision);
  return frame;
}

function candidateCard(candidate) {
  const status = statusFor(candidate);
  const card = document.createElement("article");
  card.className = `candidate-card is-${status}`;
  card.dataset.candidateId = candidate.candidate_id;
  card.append(imageFrame(candidate, status));

  const content = document.createElement("div");
  content.className = "card-content";
  const heading = document.createElement("h3");
  heading.className = "candidate-title";
  heading.textContent = candidate.title || "Untitled image";
  content.append(heading);

  const meta = document.createElement("dl");
  meta.className = "meta-grid";
  addMetadata(meta, "Creator", candidate.creator);
  addMetadata(meta, "License", candidate.license);
  content.append(meta);

  if (candidate.raw_location_text || candidate.inside_boundary === "True" || candidate.bc_in_metadata === "True") {
    const evidence = document.createElement("p");
    evidence.className = "evidence";
    const detail = candidate.raw_location_text || (candidate.inside_boundary === "True" ? "Mapped point is inside the park boundary." : "BC appears in source metadata.");
    evidence.textContent = `Location lead: ${detail}`;
    content.append(evidence);
  }

  const links = document.createElement("div");
  links.className = "source-links";
  for (const [label, url] of [["Source page", candidate.landing_url], ["Original image", candidate.image_url], ["License terms", candidate.license_url]]) {
    const link = externalLink(label, url);
    if (link) links.append(link);
  }
  content.append(links);

  const actions = document.createElement("div");
  actions.className = "card-actions";
  for (const [decision, label] of [["approved", "Approve"], ["rejected", "Reject"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `decision-button ${decision === "approved" ? "approve" : "reject"}`;
    button.classList.toggle("is-selected", status === decision);
    button.setAttribute("aria-pressed", String(status === decision));
    button.textContent = label;
    button.addEventListener("click", () => saveDecision(candidate, decision, note.value));
    actions.append(button);
  }
  content.append(actions);

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "reset-button";
  reset.textContent = "Clear decision";
  reset.hidden = status === "pending";
  reset.addEventListener("click", () => saveDecision(candidate, "pending", note.value));
  content.append(reset);

  const noteLabel = document.createElement("label");
  noteLabel.className = "note-label";
  noteLabel.textContent = "Review note (optional)";
  const note = document.createElement("textarea");
  note.className = "review-note";
  note.rows = 2;
  note.maxLength = 1000;
  note.placeholder = "Why this image fits or does not fit";
  note.value = state.decisions[candidate.candidate_id]?.note || "";
  noteLabel.append(note);
  content.append(noteLabel);
  const noteStatus = document.createElement("p");
  noteStatus.className = "note-status";
  noteStatus.textContent = "Saved when you leave this field";
  content.append(noteStatus);
  note.addEventListener("blur", (event) => {
    if (event.relatedTarget?.closest(".card-actions, .reset-button")) return;
    if (note.value !== (state.decisions[candidate.candidate_id]?.note || "")) saveDecision(candidate, statusFor(candidate), note.value);
  });

  card.append(content);
  return card;
}

function renderCurrent() {
  const place = state.places.find((item) => item.id === state.currentPlaceId);
  if (!place) return;
  const counts = placeCounts(place);
  const visible = filteredPlaces();
  const position = visible.findIndex((item) => item.id === place.id);
  ui.position.textContent = position >= 0 ? `${position + 1} of ${visible.length}` : `${state.places.findIndex((item) => item.id === place.id) + 1} of ${state.places.length}`;
  ui.previous.disabled = position <= 0;
  ui.next.disabled = position < 0 || position >= visible.length - 1;
  ui.placeName.textContent = place.name;
  ui.placeSummary.textContent = `${place.candidates.length} image ${place.candidates.length === 1 ? "candidate" : "candidates"} · ${counts.approved} approved · ${counts.rejected} rejected · ${counts.pending} to review`;
  ui.placeStatus.className = "place-status";
  ui.placeStatus.classList.toggle("has-approved", counts.approved > 0);
  ui.placeStatus.classList.toggle("is-complete", counts.pending === 0);
  ui.placeStatus.textContent = counts.pending === 0 ? "Review complete" : counts.approved ? "Has approvals" : "To review";
  ui.grid.replaceChildren(...place.candidates.map(candidateCard));
  ui.mobilePicker.value = place.id;
}

function renderAll() {
  const visible = filteredPlaces();
  if (visible.length && !visible.some((place) => place.id === state.currentPlaceId)) {
    state.currentPlaceId = visible[0].id;
  }
  renderProgress();
  renderFilters();
  renderRail();
  renderCurrent();
}

function setCurrentPlace(placeId) {
  if (!state.places.some((place) => place.id === placeId)) return;
  state.currentPlaceId = placeId;
  const url = new URL(location.href);
  url.searchParams.set("place", placeId);
  history.replaceState(null, "", url);
  renderRail();
  renderCurrent();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function movePlace(delta) {
  const places = filteredPlaces();
  const current = places.findIndex((place) => place.id === state.currentPlaceId);
  const next = places[current + delta];
  if (next) setCurrentPlace(next.id);
}

async function saveDecision(candidate, status, note) {
  if (state.pending.has(candidate.candidate_id)) return;
  state.pending.add(candidate.candidate_id);
  const card = [...ui.grid.children].find((item) => item.dataset.candidateId === candidate.candidate_id);
  card?.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    const response = await fetch("/api/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidate_id: candidate.candidate_id, status, note }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Save failed (${response.status})`);
    state.decisions[candidate.candidate_id] = result.decision;
    renderAll();
    showToast(status === "approved" ? "Approval saved locally" : status === "rejected" ? "Rejection saved locally" : "Decision saved locally");
  } catch (error) {
    card?.querySelectorAll("button").forEach((button) => { button.disabled = false; });
    showToast(`Could not save: ${error.message}`, true);
  } finally {
    state.pending.delete(candidate.candidate_id);
  }
}

async function load() {
  ui.error.hidden = true;
  ui.content.hidden = true;
  ui.loading.hidden = false;
  try {
    const response = await fetch("/api/data", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Load failed (${response.status})`);
    state.candidates = data.candidates;
    state.decisions = data.decisions || {};
    const map = new Map();
    for (const candidate of state.candidates) {
      if (!map.has(candidate.place_id)) map.set(candidate.place_id, { id: candidate.place_id, name: candidate.place_name, candidates: [] });
      map.get(candidate.place_id).candidates.push(candidate);
    }
    state.places = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    state.currentPlaceId = new URL(location.href).searchParams.get("place");
    if (!state.places.some((place) => place.id === state.currentPlaceId)) state.currentPlaceId = state.places[0]?.id || null;
    ui.savePath.textContent = data.state_path || "Saved in the local audit directory.";
    ui.loading.hidden = true;
    ui.content.hidden = false;
    renderAll();
  } catch (error) {
    ui.loading.hidden = true;
    ui.error.hidden = false;
    ui.errorMessage.textContent = `${error.message}. Confirm the local review server is running and the shortlist file is available.`;
  }
}

ui.retry.addEventListener("click", load);
ui.search.addEventListener("input", () => { state.search = ui.search.value; renderRail(); renderCurrent(); });
for (const button of ui.filters) button.addEventListener("click", () => {
  state.filter = button.dataset.filter;
  const first = filteredPlaces()[0];
  if (first && !filteredPlaces().some((place) => place.id === state.currentPlaceId)) state.currentPlaceId = first.id;
  renderAll();
});
ui.mobilePicker.addEventListener("change", () => setCurrentPlace(ui.mobilePicker.value));
ui.previous.addEventListener("click", () => movePlace(-1));
ui.next.addEventListener("click", () => movePlace(1));
document.addEventListener("keydown", (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey || ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
  if (event.key === "ArrowLeft") { event.preventDefault(); movePlace(-1); }
  if (event.key === "ArrowRight") { event.preventDefault(); movePlace(1); }
});
load();
