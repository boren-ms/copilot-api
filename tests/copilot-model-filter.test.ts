import { describe, expect, test } from "bun:test"

import type { ResolvedProviderConfig } from "~/lib/config"
import { filterCopilotModelRecords } from "~/services/copilot/cli-models-cache"

const provider: ResolvedProviderConfig = {
  name: "copilot-cli",
  type: "openai-responses",
  baseUrl: "https://api.enterprise.githubcopilot.com",
  apiKey: "test-key",
  authType: "authorization",
  autoDiscoverCopilotModels: true,
}

const excludedModelPrefixes = [
  "mai",
  "grok",
  "claude-haiku",
  "claude-sonnet",
  "gemini-3.8",
  "gpt-5.3",
  "gpt-5.4",
  "gpt-5.6",
]

describe("Copilot model exclusions", () => {
  test("excludes selected families and versions while keeping newer models", () => {
    const hidden = [
      "mai-code-1.1-flash",
      "mai-code-2",
      "mai-code-2-flash",
      "grok-4.6",
      "grok-4.7",
      "claude-haiku-4.5",
      "claude-haiku-5.5",
      "claude-sonnet-5",
      "claude-sonnet-5.5",
      "gemini-3.8-flash",
      "gpt-5.3-codex",
      "gpt-5.4-nano",
      "gpt-5.6-luna",
      "gpt-5.6-luna-utility",
      "gpt-5.6-sol",
      "gpt-5.6-sol-fast",
    ]
    const visible = [
      "claude-opus-5.5",
      "gemini-4-carbon",
      "gemini-4-argon",
      "gemini-4-hydrogen",
      "gemini-4-neon",
      "gpt-6-luna",
      "gpt-6-sol",
      "gpt-6.1-sol",
      "gpt-6.1-terra",
      "gpt-6.2-sol",
      "gpt-5.30-sol",
      "gpt-5.60-sol",
    ]
    const models = [...hidden, ...visible].map((id) => ({ id }))
    expect(
      filterCopilotModelRecords(
        { ...provider, excludedModelPrefixes },
        models,
      ).map((model) => model.id),
    ).toEqual(visible)
    expect(models).toHaveLength(hidden.length + visible.length)
  })

  test("matches exact IDs and hyphen suffixes, ignoring case and whitespace", () => {
    const models = [
      { id: "GPT-5.6" },
      { id: "GPT-5.6-SOL" },
      { id: "gpt-5.60-sol" },
      { id: 123 },
    ]
    expect(
      filterCopilotModelRecords(
        { ...provider, excludedModelPrefixes: [" ", " GPT-5.6 "] },
        models,
      ),
    ).toEqual([{ id: "gpt-5.60-sol" }, { id: 123 }])
  })

  test("leaves models unchanged when exclusions are unset or empty", () => {
    const models = [{ id: "grok-4.7" }]
    for (const prefixes of [undefined, [], [" "]]) {
      expect(
        filterCopilotModelRecords(
          { ...provider, excludedModelPrefixes: prefixes },
          models,
        ),
      ).toBe(models)
    }
  })
})
