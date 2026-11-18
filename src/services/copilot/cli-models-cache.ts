import { createHandlerLogger } from "~/lib/logger"
import type { ProviderType } from "~/lib/config-store"
import type { ResolvedProviderConfig } from "~/lib/provider-config"

const logger = createHandlerLogger("copilot-cli-models")
const REFRESH_INTERVAL_MS = 5 * 60_000
const RETRY_INTERVAL_MS = 30_000

type Catalog = Array<Record<string, unknown>>

export function usesLiveCopilotModels(
  provider: ResolvedProviderConfig,
): boolean {
  return (
    provider.name === "copilot-cli"
    && provider.type === "openai-responses"
    && provider.autoDiscoverCopilotModels === true
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getModelType(model: unknown): ProviderType | undefined {
  if (!isRecord(model)) return undefined
  const { supported_endpoints: endpoints } = model
  if (!Array.isArray(endpoints)) return undefined
  if (endpoints.includes("/responses") || endpoints.includes("ws:/responses")) {
    return "openai-responses"
  }
  if (endpoints.includes("/v1/messages")) return "anthropic"
  if (endpoints.includes("/chat/completions")) return "openai-compatible"
  return undefined
}

function isEligibleModel(model: unknown): model is Record<string, unknown> {
  if (!isRecord(model)) return false
  const { id, policy, capabilities } = model
  return (
    typeof id === "string"
    && /^[a-z0-9][a-z0-9._-]*$/iu.test(id)
    && getModelType(model) !== undefined
    && (!isRecord(policy) || policy.state !== "disabled")
    && !(
      isRecord(capabilities)
      && isRecord(capabilities.supports)
      && capabilities.supports.tool_calls === false
    )
  )
}

interface CacheEntry {
  baseUrl: string
  apiKey: string
  models?: Catalog
  refreshAt: number
  pending?: Promise<Catalog | undefined>
}

let cache: CacheEntry | undefined

export function getLiveCopilotModelType(
  provider: ResolvedProviderConfig,
  modelId: string,
): ProviderType | undefined {
  if (
    !usesLiveCopilotModels(provider)
    || cache?.baseUrl !== provider.baseUrl
    || cache.apiKey !== provider.apiKey
  ) {
    return undefined
  }
  return getModelType(cache.models?.find((model) => model.id === modelId))
}

async function refresh(entry: CacheEntry): Promise<Catalog | undefined> {
  try {
    const url = new URL("/models", entry.baseUrl)
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${entry.apiKey}`,
        accept: "application/json",
        "user-agent": "GitHubCopilotCLI/1.0.100",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 401 || response.status === 403) {
      entry.models = []
    }
    if (!response.ok) {
      throw new Error(`Copilot models returned HTTP ${response.status}`)
    }
    const body: unknown = await response.json()
    if (!isRecord(body) || !Array.isArray(body.data)) {
      throw new Error("Invalid Copilot model catalog")
    }
    entry.models = body.data.filter(isEligibleModel)
    entry.refreshAt = Date.now() + REFRESH_INTERVAL_MS
  } catch {
    entry.refreshAt = Date.now() + RETRY_INTERVAL_MS
    logger.warn("models.copilot_cli.refresh_failed")
  }
  return entry.models
}

export async function getLiveCopilotModels(
  provider: ResolvedProviderConfig,
): Promise<Catalog | undefined> {
  if (cache?.baseUrl !== provider.baseUrl || cache.apiKey !== provider.apiKey) {
    cache = { baseUrl: provider.baseUrl, apiKey: provider.apiKey, refreshAt: 0 }
  }
  const entry = cache
  if (entry.pending) return await entry.pending
  if (Date.now() < entry.refreshAt) return entry.models
  entry.pending = refresh(entry).finally(() => {
    entry.pending = undefined
  })
  return await entry.pending
}
