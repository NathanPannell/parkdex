import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleFit, hasLongHandle, SCORE_CARD_HANDLE_CHARS } from "./handleFit";

const css = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(file: string, selector: string): string {
  const match = css(file).match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`));
  if (!match) throw new Error(`${selector} not found in ${file}`);
  return match[1];
}

describe("handleFit", () => {
  it("passes the handle's length with its @ to CSS", () => {
    expect(handleFit("n8tewolf_staging_xyz")).toEqual({ "--handle-chars": 21 });
    expect(handleFit("kip")).toEqual({ "--handle-chars": 4 });
  });

  it("sets nothing without a handle, so the styles keep their full size", () => {
    expect(handleFit(null)).toBeUndefined();
    expect(handleFit(undefined)).toBeUndefined();
    expect(handleFit("")).toBeUndefined();
  });

  it("moves handles longer than the score card's limit onto their own line", () => {
    expect(hasLongHandle("a".repeat(SCORE_CARD_HANDLE_CHARS))).toBe(false);
    expect(hasLongHandle("a".repeat(SCORE_CARD_HANDLE_CHARS + 1))).toBe(true);
    expect(hasLongHandle("n8tewolf_staging_xyz")).toBe(true);
  });
});

// Handles are 3 to 20 of a-z, 0-9 and _, so the browser has nowhere to wrap one but mid-word.
describe("handle styles", () => {
  const handles: [string, string][] = [
    ["game.css", ".game-score__text strong"],
    ["game.css", ".game-identity__text strong"],
    ["game.css", ".handle-sheet__preview strong"],
    ["game.css", ".park-sheet__holder strong"],
    ["game.css", ".game-row__name strong"],
    ["game-ui.css", ".settings-flag__text strong"],
    ["game-ui.css", ".game-podium__handle"],
  ];

  it.each(handles)("%s keeps %s on one line", (file, selector) => {
    const body = rule(file, selector);
    expect(body).toContain("white-space: nowrap");
    expect(body).toContain("text-overflow: ellipsis");
    expect(body).not.toMatch(/overflow-wrap:\s*anywhere|word-break:\s*break-all/);
  });

  it("keeps the score card's long handle between 15px and 20px", () => {
    expect(rule("game.css", ".game-score.has-long-handle .game-score__text strong")).toContain("clamp(15px,");
  });
});
