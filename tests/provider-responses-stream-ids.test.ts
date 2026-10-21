import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import type {
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponsesResult,
  ResponseStreamEvent,
} from "~/lib/types/responses"
import { closeUsageStore } from "~/lib/token-usage"
import { providerResponsesHandlerDependencies } from "~/routes/provider/responses/handler"
import { providerResponsesRoutes } from "~/routes/provider/responses/route"
import { responsesHandlerDependencies } from "~/routes/responses/handler"
import { responsesRoutes } from "~/routes/responses/route"
import { responsesUtilsDependencies } from "~/routes/responses/utils"

const originalFetch = globalThis.fetch
const originalProviderDependencies = {
  ...providerResponsesHandlerDependencies,
}
const originalResponsesDependencies = { ...responsesHandlerDependencies }
const originalUtilsDependencies = { ...responsesUtilsDependencies }
const databaseEnvironmentKey = "COPILOT_API_SQLITE_DB_PATH"
let originalDatabasePath: string | undefined

const providerConfig: ResolvedProviderConfig = {
  apiKey: "synthetic-provider-key",
  authType: "authorization",
  baseUrl: "https://responses.example",
  models: { "gpt-test": {} },
  name: "copilot-cli",
  type: "openai-responses",
}

const createResult = (output: Array<ResponseOutputItem>): ResponsesResult => ({
  created_at: 0,
  error: null,
  id: "resp-test",
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model: "gpt-test",
  object: "response",
  output,
  output_text: "Hello once",
  parallel_tool_calls: false,
  status: "completed",
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  usage: null,
})

const createMessage = (id: string): ResponseOutputMessage => ({
  id,
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "Hello once", annotations: [] }],
})

const messageEvents = (prefix: string): Array<ResponseStreamEvent> => [
  {
    type: "response.output_item.added",
    sequence_number: 0,
    output_index: 0,
    item: {
      ...createMessage(`${prefix}-added`),
      status: "in_progress",
      content: [],
    },
  },
  {
    type: "response.content_part.added",
    sequence_number: 1,
    output_index: 0,
    item_id: `${prefix}-part-added`,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  },
  {
    type: "response.output_text.delta",
    sequence_number: 2,
    output_index: 0,
    item_id: `${prefix}-delta-1`,
    content_index: 0,
    delta: "Hello ",
  },
  {
    type: "response.output_text.delta",
    sequence_number: 3,
    output_index: 0,
    item_id: `${prefix}-delta-2`,
    content_index: 0,
    delta: "once",
  },
  {
    type: "response.output_text.done",
    sequence_number: 4,
    output_index: 0,
    item_id: `${prefix}-text-done`,
    content_index: 0,
    text: "Hello once",
  },
  {
    type: "response.content_part.done",
    sequence_number: 5,
    output_index: 0,
    item_id: `${prefix}-part-done`,
    content_index: 0,
    part: { type: "output_text", text: "Hello once", annotations: [] },
  },
  {
    type: "response.output_item.done",
    sequence_number: 6,
    output_index: 0,
    item: createMessage(`${prefix}-done`),
  },
  {
    type: "response.completed",
    sequence_number: 7,
    response: createResult([createMessage(`${prefix}-completed`)]),
  },
]

const createUpstream = (
  events: Array<ResponseStreamEvent>,
  dataOnly = false,
): Response =>
  new Response(
    events
      .map(
        (event) =>
          `${dataOnly ? "" : `event: ${event.type}\n`}data: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )

const fetchMock = mock(() =>
  Promise.resolve(createUpstream(messageEvents("message"))),
)

const createApp = (): Hono => {
  const app = new Hono()
  app.route("/v1/responses", responsesRoutes)
  app.route("/:provider/v1/responses", providerResponsesRoutes)
  return app
}

const requestStream = async (
  path: string,
): Promise<Array<ResponseStreamEvent>> => {
  const response = await createApp().request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "codex/0.163.0",
    },
    body: JSON.stringify({
      model: path === "/v1/responses" ? "copilot-cli/gpt-test" : "gpt-test",
      input: "Reply once",
      stream: true,
    }),
  })
  expect(response.status).toBe(200)
  const text = await response.text()
  return text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()) as ResponseStreamEvent)
}

beforeEach(async () => {
  originalDatabasePath = process.env[databaseEnvironmentKey]
  process.env[databaseEnvironmentKey] = ":memory:"
  await closeUsageStore()
  providerResponsesHandlerDependencies.resolveProviderConfig = () =>
    Promise.resolve(providerConfig)
  responsesHandlerDependencies.resolveMappedModel = (model) => model
  responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
    false
  fetchMock.mockReset()
  fetchMock.mockImplementation(() =>
    Promise.resolve(createUpstream(messageEvents("message"))),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  Object.assign(
    providerResponsesHandlerDependencies,
    originalProviderDependencies,
  )
  Object.assign(responsesHandlerDependencies, originalResponsesDependencies)
  Object.assign(responsesUtilsDependencies, originalUtilsDependencies)
  await closeUsageStore()
  if (originalDatabasePath === undefined) {
    Reflect.deleteProperty(process.env, databaseEnvironmentKey)
  } else {
    process.env[databaseEnvironmentKey] = originalDatabasePath
  }
})

describe("provider Responses stream identities", () => {
  for (const path of ["/v1/responses", "/copilot-cli/v1/responses"]) {
    for (const dataOnly of [false, true]) {
      test(`${path} stabilizes message IDs across ${dataOnly ? "data-only" : "named"} SSE events`, async () => {
        fetchMock.mockImplementation(() =>
          Promise.resolve(createUpstream(messageEvents("message"), dataOnly)),
        )
        const events = await requestStream(path)
        expect(events).toHaveLength(8)
        for (const event of events) {
          if ("item" in event) expect(event.item.id).toBe("message-added")
          if ("item_id" in event) expect(event.item_id).toBe("message-added")
          if (event.type === "response.completed") {
            expect(event.response.output).toEqual([
              createMessage("message-added"),
            ])
          }
        }
        const deltaText = events
          .filter((event) => event.type === "response.output_text.delta")
          .map((event) => event.delta)
          .join("")
        expect(deltaText).toBe("Hello once")
        expect(fetchMock).toHaveBeenCalledTimes(1)
      })
    }
  }

  test("keeps request trackers isolated across streams that reuse output indexes", async () => {
    fetchMock
      .mockImplementationOnce(() =>
        Promise.resolve(createUpstream(messageEvents("first"))),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(createUpstream(messageEvents("second"))),
      )
    for (const prefix of ["first", "second"]) {
      const events = await requestStream("/v1/responses")
      const completed = events.find(
        (event) => event.type === "response.completed",
      )
      expect(completed?.response.output[0].id).toBe(`${prefix}-added`)
    }
  })

  test("preserves tool call IDs and encrypted reasoning while stabilizing item identities", async () => {
    const reasoning: ResponseOutputItem = {
      id: "reasoning-added",
      type: "reasoning",
      summary: [],
      encrypted_content: "opaque-encrypted-reasoning",
    }
    const tool: ResponseOutputItem = {
      id: "tool-added",
      type: "function_call",
      call_id: "call-original",
      name: "read_file",
      arguments: '{"path":"example.txt"}',
      status: "completed",
    }
    const upstreamEvents: Array<ResponseStreamEvent> = [
      {
        type: "response.output_item.added",
        sequence_number: 0,
        output_index: 0,
        item: reasoning,
      },
      {
        type: "response.output_item.done",
        sequence_number: 1,
        output_index: 0,
        item: { ...reasoning, id: "reasoning-done" },
      },
      {
        type: "response.output_item.added",
        sequence_number: 2,
        output_index: 1,
        item: tool,
      },
      {
        type: "response.function_call_arguments.delta",
        sequence_number: 3,
        output_index: 1,
        item_id: "tool-delta",
        delta: tool.arguments,
      },
      {
        type: "response.output_item.done",
        sequence_number: 4,
        output_index: 1,
        item: { ...tool, id: "tool-done" },
      },
      {
        type: "response.completed",
        sequence_number: 5,
        response: createResult([
          { ...reasoning, id: "reasoning-completed" },
          { ...tool, id: "tool-completed" },
        ]),
      },
    ]
    fetchMock.mockImplementation(() =>
      Promise.resolve(createUpstream(upstreamEvents)),
    )
    const events = await requestStream("/v1/responses")
    const completed = events.find(
      (event) => event.type === "response.completed",
    )
    expect(completed?.response.output).toEqual([reasoning, tool])
    const argumentsEvent = events.find(
      (event) => event.type === "response.function_call_arguments.delta",
    )
    expect(argumentsEvent?.item_id).toBe("tool-added")
    expect(argumentsEvent?.delta).toBe(tool.arguments)
  })
})
