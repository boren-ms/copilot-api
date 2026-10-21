import { spawnSync } from "node:child_process"
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

function readGhToken() {
  const gh = spawnSync("gh", ["auth", "token", "--hostname", "github.com"], {
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (gh.error || gh.status !== 0 || !gh.stdout.trim()) {
    throw new Error(
      "Cannot reuse GitHub CLI authentication. Check gh auth status.",
    )
  }
  return gh.stdout.trim()
}

export async function prepareGhAuth(
  configPath,
  { readToken = readGhToken, fetcher = fetch } = {},
) {
  const providerName = "copilot-cli"
  const token = readToken()
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/json",
    "User-Agent": "GitHubCopilotCLI/1.0.100",
  }
  async function getJson(url, label) {
    const response = await fetcher(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) {
      throw new Error(label + " returned HTTP " + response.status)
    }
    return response.json()
  }

  const user = await getJson(
    "https://api.github.com/copilot_internal/user",
    "Copilot account",
  )
  const api = new URL(user.endpoints.api)
  const allowedHosts = [
    "api.githubcopilot.com",
    "api.business.githubcopilot.com",
    "api.enterprise.githubcopilot.com",
  ]
  if (
    api.protocol !== "https:"
    || !allowedHosts.includes(api.host)
    || api.username
    || api.password
  ) {
    throw new Error("Copilot account returned an unsupported API endpoint.")
  }
  const catalog = await getJson(
    new URL("/models", api),
    "Copilot model discovery",
  )
  if (!Array.isArray(catalog.data)) {
    throw new Error("Copilot returned an invalid model catalog.")
  }
  const models = catalog.data.filter(
    (model) =>
      model.supported_endpoints?.includes("/responses")
      && model.policy?.state !== "disabled",
  )
  if (
    !models.some(
      (model) =>
        model.id === "gpt-6.1-sol" && model.capabilities?.supports?.tool_calls,
    )
  ) {
    throw new Error(
      "The authenticated account does not expose GPT-6.1 Sol with tool support.",
    )
  }
  const config = JSON.parse(await readFile(configPath, "utf8"))
  config.providers ??= {}
  config.providers["github-copilot"] = {
    ...config.providers["github-copilot"],
    enabled: false,
  }
  config.providers[providerName] = {
    type: "openai-responses",
    enabled: true,
    baseUrl: api.origin,
    modelsDevProviderId: "github-copilot",
    authType: "authorization",
    apiKey: token,
    agentsModels: models.map((model) => model.id),
    models: Object.fromEntries(
      models.map((model) => {
        const limits = model.capabilities?.limits
        const supports = model.capabilities?.supports
        const entry = {
          contextWindow: limits?.max_context_window_tokens,
          maxOutputTokens: limits?.max_output_tokens,
          inputModalities: supports?.vision ? ["text", "image"] : ["text"],
          supportPdf:
            limits?.vision?.supported_media_types?.includes("application/pdf")
            ?? false,
        }
        if (Array.isArray(supports?.reasoning_effort)) {
          entry.reasoningEfforts = supports.reasoning_effort
          if (supports.reasoning_effort.includes("medium")) {
            entry.defaultReasoningEffort = "medium"
          }
        }
        return [model.id, entry]
      }),
    ),
  }
  config.modelMappings ??= {}
  for (const model of models) {
    config.modelMappings[model.id] ??= providerName + "/" + model.id
  }
  for (const alias of ["codex-auto-review", "gpt-reserve"]) {
    if (config.modelMappings[alias] === "gpt-6-luna") {
      config.modelMappings[alias] = providerName + "/gpt-6-luna"
    }
  }
  const temporaryPath = configPath + ".gh-auth-" + process.pid
  let created = false
  try {
    await writeFile(temporaryPath, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    })
    created = true
    await rename(temporaryPath, configPath)
    await chmod(configPath, 0o600)
  } finally {
    if (created) {
      await unlink(temporaryPath).catch((error) => {
        if (error.code !== "ENOENT") throw error
      })
    }
  }
  return { login: user.login, modelCount: models.length, api: api.origin }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const appDir =
    process.env.COPILOT_API_HOME
    || join(homedir(), ".local", "share", "copilot-api")
  const result = await prepareGhAuth(join(appDir, "config.json"))
  console.log(
    "Reused Copilot CLI authentication via gh for "
      + result.login
      + "; "
      + result.modelCount
      + " Responses models at "
      + result.api,
  )
}
