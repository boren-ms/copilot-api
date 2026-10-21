import { describe, expect, test } from "bun:test"

import type {
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponsesResult,
  ResponseStreamEvent,
} from "~/lib/types/responses"
import {
  createStreamIdTracker,
  fixStreamIds,
} from "~/routes/responses/stream-id-sync"

type Tracker = ReturnType<typeof createStreamIdTracker>

const normalize = <T extends { type: string }>(
  event: T,
  tracker: Tracker,
  eventName: string | undefined = event.type,
): T => JSON.parse(fixStreamIds(JSON.stringify(event), eventName, tracker)) as T

const message = (id: string, text = "Hello"): ResponseOutputMessage => ({
  id,
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
})

const result = (output: Array<ResponseOutputItem>): ResponsesResult => ({
  id: "resp_1",
  object: "response",
  created_at: 1,
  model: "gpt-test",
  output,
  output_text: "Hello",
  status: "completed",
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: { preserved: "value" },
  parallel_tool_calls: false,
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
})

describe("Responses stream ID synchronization", () => {
  test("keeps one message ID when upstream changes it on every event", () => {
    const tracker = createStreamIdTracker()
    const events: Array<ResponseStreamEvent> = [
      {
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: 1,
        item: { ...message("message-added", ""), status: "in_progress" },
      },
      {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        sequence_number: 2,
        item_id: "content-added",
        part: { type: "output_text", text: "", annotations: [] },
      },
      ...["Hel", "lo"].map(
        (delta, index): ResponseStreamEvent => ({
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          sequence_number: index + 3,
          item_id: `text-delta-${index}`,
          delta,
        }),
      ),
      {
        type: "response.output_text.done",
        output_index: 0,
        content_index: 0,
        sequence_number: 5,
        item_id: "text-done",
        text: "Hello",
      },
      {
        type: "response.content_part.done",
        output_index: 0,
        content_index: 0,
        sequence_number: 6,
        item_id: "content-done",
        part: { type: "output_text", text: "Hello", annotations: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        sequence_number: 7,
        item: message("message-done"),
      },
      {
        type: "response.completed",
        sequence_number: 8,
        response: result([message("message-completed")]),
      },
    ]

    const fixed = events.map((event) => normalize(event, tracker))
    expect(fixed).toHaveLength(events.length)
    for (const event of fixed) {
      if ("item" in event) expect(event.item.id).toBe("message-added")
      if ("item_id" in event) expect(event.item_id).toBe("message-added")
    }
    const terminal = fixed.at(-1)
    expect(terminal?.type).toBe("response.completed")
    if (terminal?.type !== "response.completed")
      throw new Error("Missing result")
    expect(terminal.response).toEqual(result([message("message-added")]))
    expect(
      fixed.flatMap((event) =>
        event.type === "response.output_text.delta" ? [event.delta] : [],
      ),
    ).toEqual(["Hel", "lo"])
    expect(fixed.map((event) => event.sequence_number)).toEqual(
      events.map((event) => event.sequence_number),
    )
  })

  test("keeps independent IDs and preserves tool and reasoning fields", () => {
    const tracker = createStreamIdTracker()
    const output: Array<ResponseOutputItem> = [
      {
        type: "reasoning",
        id: "reasoning-added",
        encrypted_content: "encrypted-reasoning",
        summary: [{ type: "summary_text", text: "Thinking" }],
      },
      {
        type: "function_call",
        id: "function-added",
        call_id: "function-call-id",
        name: "read_file",
        arguments: '{"path":"file.ts"}',
        namespace: "functions",
      },
      {
        type: "custom_tool_call",
        id: "custom-added",
        call_id: "custom-call-id",
        name: "apply_patch",
        input: "*** Begin Patch",
      },
      message("message-added"),
    ]
    output.forEach((item, outputIndex) => {
      normalize(
        {
          type: "response.output_item.added",
          output_index: outputIndex,
          sequence_number: outputIndex,
          item,
        },
        tracker,
      )
    })
    const fixed = normalize(
      {
        type: "response.completed",
        sequence_number: 10,
        response: result(
          output.map((item, index) => ({ ...item, id: `terminal-${index}` })),
        ),
      },
      tracker,
    )

    expect(fixed.response.output).toEqual(output)
    expect(fixed.response.metadata).toEqual({ preserved: "value" })
    expect(fixed.response.id).toBe("resp_1")
  })

  test.each(["response.completed", "response.incomplete", "response.failed"])(
    "normalizes %s output IDs",
    (type) => {
      const tracker = createStreamIdTracker()
      normalize(
        {
          type: "response.output_item.added",
          item: message("canonical"),
          output_index: 0,
        },
        tracker,
      )
      const fixed = normalize(
        { type, response: result([message("terminal")]) },
        tracker,
      )
      expect(fixed.response.output[0].id).toBe("canonical")
    },
  )

  test("generates a missing added ID once and reuses it", () => {
    const tracker = createStreamIdTracker()
    const item: ResponseOutputItem = {
      type: "function_call",
      name: "read_file",
      call_id: "call_1",
      arguments: "{}",
    }
    const added = normalize(
      { type: "response.output_item.added", output_index: 0, item },
      tracker,
    )
    const canonicalId = added.item.id
    expect(canonicalId).toMatch(/^oi_0_/u)
    if (!canonicalId) throw new Error("Missing generated item ID")
    const done = normalize(
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { ...item, id: "done-id" },
      },
      tracker,
    )
    expect(done.item.id).toBe(canonicalId)
    expect(done.item.call_id).toBe("call_1")
  })

  test("does not replace a canonical ID on another added event", () => {
    const tracker = createStreamIdTracker()
    for (const id of ["first", "second"]) {
      const fixed = normalize(
        {
          type: "response.output_item.added",
          output_index: 0,
          item: message(id),
        },
        tracker,
      )
      expect(fixed.item.id).toBe("first")
    }
  })

  test("tracks done IDs when upstream omits added events", () => {
    const tracker = createStreamIdTracker()
    normalize(
      {
        type: "response.output_item.done",
        output_index: 0,
        item: message("done"),
      },
      tracker,
    )
    const fixed = normalize(
      { type: "response.completed", response: result([message("terminal")]) },
      tracker,
    )
    expect(fixed.response.output[0].id).toBe("done")
  })

  test("uses an early item_id when an added event arrives late", () => {
    const tracker = createStreamIdTracker()
    normalize(
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "delta-id",
        delta: "Hello",
      },
      tracker,
    )
    const fixed = normalize(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: message("added-id"),
      },
      tracker,
    )
    expect(fixed.item.id).toBe("delta-id")
  })

  test("uses JSON event types when SSE event names are missing or empty", () => {
    const tracker = createStreamIdTracker()
    const added = {
      type: "response.output_item.added",
      output_index: 0,
      item: message("added"),
    }
    fixStreamIds(JSON.stringify(added), undefined, tracker)
    const done = normalize(
      {
        type: "response.output_item.done",
        output_index: 0,
        item: message("done"),
      },
      tracker,
      "",
    )
    expect(done.item.id).toBe("added")
  })

  test.each(["", "[DONE]", "invalid JSON", "null", '"text"', "1"])(
    "passes through non-event data %j",
    (data) => {
      expect(fixStreamIds(data, undefined, createStreamIdTracker())).toBe(data)
    },
  )

  test("preserves valid event bytes and leaves unrelated fields unchanged", () => {
    const tracker = createStreamIdTracker()
    const data = JSON.stringify(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: message("id"),
      },
      null,
      2,
    )
    expect(fixStreamIds(data, undefined, tracker)).toBe(data)
    for (const event of [
      { type: "response.future_event", output_index: 0, progress: "working" },
      { type: "response.future_event", item_id: "unindexed-id" },
      { type: "response.created", response: result([]) },
    ]) {
      const original = JSON.stringify(event, null, 2)
      expect(fixStreamIds(original, undefined, tracker)).toBe(original)
    }
  })

  test("isolates canonical IDs between response streams", () => {
    for (const id of ["first-stream", "second-stream"]) {
      const tracker = createStreamIdTracker()
      normalize(
        {
          type: "response.output_item.added",
          output_index: 0,
          item: message(id),
        },
        tracker,
      )
      const fixed = normalize(
        {
          type: "response.output_text.delta",
          output_index: 0,
          item_id: "changed-id",
          delta: "Hello",
        },
        tracker,
      )
      expect(fixed.item_id).toBe(id)
    }
  })

  test("preserves sparse upstream terminal and output-item events", () => {
    const tracker = createStreamIdTracker()
    for (const event of [
      { type: "response.failed" },
      { type: "response.failed", response: null },
      { type: "response.completed", response: { id: "response-only" } },
      { type: "response.incomplete", response: { output: null } },
      { type: "response.output_item.added", output_index: 0 },
      { type: "response.output_item.done", item: message("unindexed") },
      { type: "response.completed", response: { output: [null] } },
    ]) {
      const data = JSON.stringify(event)
      expect(fixStreamIds(data, undefined, tracker)).toBe(data)
    }
  })
})
