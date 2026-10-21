/**
 * Stream ID Synchronization for Responses API clients
 *
 * Problem: GitHub Copilot's Responses API returns different IDs for the same
 * item across stream events and terminal response output. Clients such as
 * Codex desktop and @ai-sdk/openai require one ID for the entire item lifecycle.
 *
 * Errors without this fix:
 * - "activeReasoningPart.summaryParts" undefined
 * - "text part not found"
 *
 * Use case: OpenCode (AI coding assistant) using Codex models (gpt-5.2-codex)
 * via @ai-sdk/openai provider requires the Responses API endpoint.
 */

import { randomUUID } from "node:crypto"

import type {
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseOutputItem,
  ResponsesResult,
  ResponseStreamEvent,
} from "~/lib/types/responses"

interface StreamIdTracker {
  outputItems: Map<number, string>
}

export const createStreamIdTracker = (): StreamIdTracker => ({
  outputItems: new Map(),
})

export const fixStreamIds = (
  data: string,
  event: string | undefined,
  tracker: StreamIdTracker,
): string => {
  if (!data || data === "[DONE]") return data
  let parsed: ResponseStreamEvent
  try {
    parsed = JSON.parse(data) as ResponseStreamEvent
  } catch {
    return data
  }
  if (!parsed || typeof parsed !== "object") return data

  let changed = false
  switch (event || parsed.type) {
    case "response.output_item.added":
    case "response.output_item.done": {
      const itemEvent = parsed as
        | ResponseOutputItemAddedEvent
        | ResponseOutputItemDoneEvent
      changed = synchronizeOutputItemId(
        itemEvent.item,
        itemEvent.output_index,
        tracker,
      )
      break
    }
    case "response.completed":
    case "response.incomplete":
    case "response.failed": {
      const terminalEvent = parsed as Extract<
        ResponseStreamEvent,
        { response: ResponsesResult }
      >
      if (!Array.isArray(terminalEvent.response?.output)) break
      terminalEvent.response.output.forEach((item, outputIndex) => {
        if (synchronizeOutputItemId(item, outputIndex, tracker)) changed = true
      })
      break
    }
    default: {
      changed = synchronizeItemId(parsed, tracker)
    }
  }
  return changed ? JSON.stringify(parsed) : data
}

const synchronizeOutputItemId = (
  item: ResponseOutputItem,
  outputIndex: number,
  tracker: StreamIdTracker,
): boolean => {
  if (!item || typeof item !== "object" || !Number.isInteger(outputIndex)) {
    return false
  }
  const canonicalId =
    tracker.outputItems.get(outputIndex)
    || item.id
    || `oi_${outputIndex}_${randomUUID()}`
  tracker.outputItems.set(outputIndex, canonicalId)
  if (item.id === canonicalId) return false
  item.id = canonicalId
  return true
}

const synchronizeItemId = (
  parsed: ResponseStreamEvent & { output_index?: number; item_id?: string },
  tracker: StreamIdTracker,
): boolean => {
  const outputIndex = parsed.output_index
  if (outputIndex === undefined || typeof parsed.item_id !== "string") {
    return false
  }
  const canonicalId = tracker.outputItems.get(outputIndex) ?? parsed.item_id
  tracker.outputItems.set(outputIndex, canonicalId)
  if (parsed.item_id === canonicalId) return false
  parsed.item_id = canonicalId
  return true
}
