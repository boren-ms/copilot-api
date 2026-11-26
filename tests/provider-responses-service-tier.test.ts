import { afterEach, expect, mock, test } from "bun:test"

import type { ResolvedProviderConfig } from "~/lib/config"
import type { ResponsesPayload } from "~/lib/types/responses"
import { forwardProviderResponses } from "~/services/providers/provider-proxy"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

for (const serviceTier of ["priority", "auto", "default", null, undefined]) {
  test(`omits Copilot service_tier ${String(serviceTier)} upstream`, async () => {
    await checkForwardedTier("github-copilot", serviceTier, undefined)
  })
}

test("preserves service_tier for other Responses providers", async () => {
  await checkForwardedTier("openai", "priority", "priority")
})

for (const [modelsDevProviderId, model, context, expectedContext] of [
  ["github-copilot", "gpt-5.3-codex", "all_turns", "auto"],
  ["github-copilot", "gpt-5.3-codex-2026-02-24", "all_turns", "auto"],
  ["github-copilot", "gpt-5.3-codex", "current_turn", "current_turn"],
  ["github-copilot", "gpt-6.1-sol", "all_turns", "all_turns"],
  ["openai", "gpt-5.3-codex", "all_turns", "all_turns"],
] as const) {
  test(`forwards reasoning context for ${modelsDevProviderId} ${model} with ${context}`, async () => {
    const provider: ResolvedProviderConfig = {
      apiKey: "test-key",
      authType: "authorization",
      baseUrl: "https://provider.example",
      modelsDevProviderId,
      name: "custom-provider",
      type: "openai-responses",
    }
    const fetchMock = mock((_url: unknown, _init?: RequestInit) =>
      Promise.resolve(Response.json({ ok: true })),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const payload: ResponsesPayload = {
      input: "hello",
      model,
      reasoning: { context, effort: "medium" },
    }
    const response = await forwardProviderResponses(
      provider,
      payload,
      new Headers(),
    )
    await response.text()

    const [, init] = fetchMock.mock.calls[0]
    if (typeof init?.body !== "string") {
      throw new Error("Expected a JSON string request body")
    }
    const body = JSON.parse(init.body) as Pick<ResponsesPayload, "reasoning">
    expect(body.reasoning).toEqual({
      context: expectedContext,
      effort: "medium",
    })
  })
}

async function checkForwardedTier(
  modelsDevProviderId: string,
  serviceTier: ResponsesPayload["service_tier"],
  expectedTier: ResponsesPayload["service_tier"],
) {
  const provider: ResolvedProviderConfig = {
    apiKey: "test-key",
    authType: "authorization",
    baseUrl: "https://provider.example",
    modelsDevProviderId,
    name: "custom-provider",
    type: "openai-responses",
  }
  const payload: ResponsesPayload = {
    input: "hello",
    model: "gpt-test",
    service_tier: serviceTier,
  }
  const fetchMock = mock((_url: unknown, _init?: RequestInit) =>
    Promise.resolve(Response.json({ ok: true })),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await forwardProviderResponses(
    provider,
    payload,
    new Headers(),
  )
  await response.text()

  expect(fetchMock).toHaveBeenCalledTimes(1)
  const [, init] = fetchMock.mock.calls[0]
  if (typeof init?.body !== "string") {
    throw new Error("Expected a JSON string request body")
  }
  const body = JSON.parse(init.body) as Record<string, unknown>
  expect(body.model).toBe("gpt-test")
  expect(body.input).toBe("hello")
  if (expectedTier === undefined) {
    expect(body).not.toHaveProperty("service_tier")
  } else {
    expect(body.service_tier).toBe(expectedTier)
  }
}
