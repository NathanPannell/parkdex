import { moderate, type ModerationEnv, type ModerationFetch } from "./moderation.js";
import type { ChoiceAnswer, ProposalModerator } from "./proposalReview.js";

/**
 * Park proposal checks through the shared moderation module. Null without OPENROUTER_API_KEY,
 * so every proposal waits for the operator as before.
 */
export function createProposalModerator(env: ModerationEnv, fetcher?: ModerationFetch, timeoutMs?: number): ProposalModerator | null {
  if (!env.OPENROUTER_API_KEY?.trim()) return null;
  return async (input) => {
    const result = await moderate(input, env, fetcher, timeoutMs);
    if (!result) return null;
    const answers: Record<string, ChoiceAnswer> = {};
    for (const [name, answer] of Object.entries(result.answers)) {
      // Every proposal question is a choice; anything else means the answer is unusable.
      if (answer.type !== "choice") return null;
      answers[name] = { choice: answer.choice, probabilities: answer.probabilities };
    }
    return { model: result.model || null, answers };
  };
}
