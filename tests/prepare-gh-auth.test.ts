import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { prepareGhAuth } from "../deploy/local/prepare-gh-auth.mjs"
import type { AppConfig } from "~/lib/config-store"

const tempDirs: Array<string> = []
const api = "https://api.enterprise.githubcopilot.com"
const target = {
  id: "gpt-6.1-sol",
  supported_endpoints: ["/responses"],
  capabilities: {
    limits: {
      max_context_window_tokens: 1050000,
      max_output_tokens: 128000,
      vision: { supported_media_types: ["image/png", "application/pdf"] },
    },
    supports: {
      tool_calls: true,
      vision: true,
      reasoning_effort: ["low", "medium", "max"],
    },
  },
}

function fixture(
  options: {
    config?: unknown
    endpoint?: string
    catalog?: unknown
    accountStatus?: number
    modelsStatus?: number
  } = {},
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-gh-auth-"))
  tempDirs.push(directory)
  const configPath = path.join(directory, "config.json")
  const original = JSON.stringify(options.config ?? {}) + "\n"
  fs.writeFileSync(configPath, original, { mode: 0o600 })
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      requests.push({ url, init })
      const account = url === "https://api.github.com/copilot_internal/user"
      return Promise.resolve(
        Response.json(
          account ?
            { login: "test-user", endpoints: { api: options.endpoint ?? api } }
          : (options.catalog ?? { data: [target] }),
          {
            status:
              account ?
                (options.accountStatus ?? 200)
              : (options.modelsStatus ?? 200),
          },
        ),
      )
    },
    { preconnect() {} },
  )
  return {
    directory,
    configPath,
    original,
    requests,
    run: () =>
      prepareGhAuth(configPath, {
        readToken: () => "test-gh-credential",
        fetcher,
      }),
    read: () => JSON.parse(fs.readFileSync(configPath, "utf8")) as AppConfig,
  }
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

async function expectFailure(run: () => Promise<unknown>, message = "") {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : "").toContain(message)
    return
  }
  throw new Error("Expected authentication preparation to fail")
}

describe("local gh authentication preparation", () => {
  test("preserves gateway keys, unrelated providers and explicit mappings", async () => {
    const f = fixture({
      config: {
        auth: { apiKeys: ["test-gateway-key"], adminApiKey: "test-admin-key" },
        providers: {
          other: { enabled: true, apiKey: "other-test-key" },
          "github-copilot": { agentsModels: ["existing"] },
        },
        modelMappings: {
          "gpt-6.1-sol": "other/custom-model",
          "codex-auto-review": "gpt-6-luna",
          "gpt-reserve": "other/reserve",
        },
      },
      catalog: {
        data: [
          target,
          { id: "gpt-6-luna", supported_endpoints: ["/responses"] },
          { ...target, id: "disabled", policy: { state: "disabled" } },
          {
            ...target,
            id: "chat-only",
            supported_endpoints: ["/chat/completions"],
          },
          { id: "no-endpoints" },
        ],
      },
    })
    await f.run()
    const saved = f.read()
    expect(saved.auth).toEqual({
      apiKeys: ["test-gateway-key"],
      adminApiKey: "test-admin-key",
    })
    expect(saved.providers?.other).toEqual({
      enabled: true,
      apiKey: "other-test-key",
    })
    expect(saved.providers?.["github-copilot"]).toEqual({
      enabled: false,
      agentsModels: ["existing"],
    })
    const provider = saved.providers?.["copilot-cli"]
    expect(provider).toMatchObject({
      type: "openai-responses",
      enabled: true,
      baseUrl: api,
      apiKey: "test-gh-credential",
      agentsModels: ["gpt-6.1-sol", "gpt-6-luna"],
    })
    expect(provider?.models?.["gpt-6.1-sol"]).toEqual({
      contextWindow: 1050000,
      maxOutputTokens: 128000,
      inputModalities: ["text", "image"],
      supportPdf: true,
      reasoningEfforts: ["low", "medium", "max"],
      defaultReasoningEffort: "medium",
    })
    expect(provider?.models?.["gpt-6-luna"]).toEqual({
      inputModalities: ["text"],
      supportPdf: false,
    })
    expect(saved.modelMappings).toEqual({
      "gpt-6.1-sol": "other/custom-model",
      "gpt-6-luna": "copilot-cli/gpt-6-luna",
      "codex-auto-review": "copilot-cli/gpt-6-luna",
      "gpt-reserve": "other/reserve",
    })
    expect(fs.statSync(f.configPath).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(f.directory)).toEqual(["config.json"])
    expect(f.requests.map((r) => r.url)).toEqual([
      "https://api.github.com/copilot_internal/user",
      api + "/models",
    ])
    for (const request of f.requests) {
      expect(new Headers(request.init?.headers).get("Authorization")).toBe(
        "Bearer test-gh-credential",
      )
      expect(request.init?.redirect).toBe("error")
    }
  })

  test("initializes provider and mapping tables in an empty config", async () => {
    const f = fixture()
    await f.run()
    expect(f.read().modelMappings?.["gpt-6.1-sol"]).toBe(
      "copilot-cli/gpt-6.1-sol",
    )
    expect(f.read().providers?.["github-copilot"]?.enabled).toBe(false)
  })

  test.each([
    "https://example.com",
    "http://api.enterprise.githubcopilot.com",
    "https://api.enterprise.githubcopilot.com:8443",
    "https://user:password@api.enterprise.githubcopilot.com",
  ])(
    "rejects unsafe endpoint %s before sending a credential",
    async (endpoint) => {
      const f = fixture({ endpoint })
      await expectFailure(f.run, "unsupported API endpoint")
      expect(f.requests).toHaveLength(1)
      expect(fs.readFileSync(f.configPath, "utf8")).toBe(f.original)
    },
  )

  test.each([{ accountStatus: 403 }, { modelsStatus: 401 }])(
    "preserves config when upstream rejects access: %j",
    async (options) => {
      const f = fixture(options)
      await expectFailure(f.run, "returned HTTP")
      expect(fs.readFileSync(f.configPath, "utf8")).toBe(f.original)
    },
  )

  test("rejects an invalid model catalog", async () => {
    const f = fixture({ catalog: { data: {} } })
    await expectFailure(f.run, "invalid model catalog")
    expect(fs.readFileSync(f.configPath, "utf8")).toBe(f.original)
  })

  test.each([
    { data: [] },
    {
      data: [{ ...target, capabilities: { supports: { tool_calls: false } } }],
    },
  ])(
    "rejects accounts lacking the required model and tools: %j",
    async ({ data }) => {
      const f = fixture({ catalog: { data } })
      await expectFailure(f.run, "GPT-6.1 Sol with tool support")
      expect(fs.readFileSync(f.configPath, "utf8")).toBe(f.original)
    },
  )

  test("preserves a corrupt config rather than replacing it", async () => {
    const f = fixture()
    fs.writeFileSync(f.configPath, "{broken")
    await expectFailure(f.run)
    expect(fs.readFileSync(f.configPath, "utf8")).toBe("{broken")
  })

  test("does not overwrite or delete a preexisting temporary file", async () => {
    const f = fixture()
    const temporaryPath = f.configPath + ".gh-auth-" + process.pid
    fs.writeFileSync(temporaryPath, "preserve-existing-file")
    await expectFailure(f.run, "EEXIST")
    expect(fs.readFileSync(temporaryPath, "utf8")).toBe(
      "preserve-existing-file",
    )
    expect(fs.readFileSync(f.configPath, "utf8")).toBe(f.original)
  })
})
