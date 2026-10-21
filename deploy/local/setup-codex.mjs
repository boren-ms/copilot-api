#!/usr/bin/env bun
import { TOML } from "bun"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"

const providerId = "copilot-api-community"
const defaultModel = "copilot-cli/gpt-6.1-sol"
const defaultUrl = "http://127.0.0.1:4141"
const beginMarker = "# >>> copilot-api Codex Desktop >>>"
const endMarker = "# <<< copilot-api Codex Desktop <<<"
const remove = Symbol("remove")

/** @typedef {Record<string, unknown>} Table */
/** @typedef {{model?: string, url?: string}} ConfigOptions */
/** @typedef {{start: number, end: number, path: string[], array: boolean}} Section */
/** @typedef {{start: number, end: number, lines: string[]}} Edit */

/** @param {unknown} value @returns {value is Table} */
function isTable(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** @param {string} source @returns {Table} */
function parseConfig(source) {
  try {
    return TOML.parse(source)
  } catch {
    throw new Error("Invalid Codex TOML; the configuration was not changed")
  }
}

/** @param {string} value */
function normalizeUrl(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error("Gateway URL must be an HTTP or HTTPS URL")
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(
      "Gateway URL must be an HTTP or HTTPS URL without credentials, query, or fragment",
    )
  }
  return value.replace(/\/+$/, "")
}

/** @param {string} key */
function tomlKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}

/** @param {unknown} value @returns {string} */
function tomlValue(value) {
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`
  if (isTable(value)) {
    return `{ ${Object.entries(value)
      .map(([key, entry]) => `${tomlKey(key)} = ${tomlValue(entry)}`)
      .join(", ")} }`
  }
  throw new Error("Cannot safely update Codex TOML: unsupported value")
}

/** Find a key path using the TOML parser so quoted table/key names stay valid.
 * @param {unknown} value @param {string} marker @param {string[]} [prefix]
 * @returns {string[] | undefined}
 */
function markerPath(value, marker, prefix = []) {
  if (Array.isArray(value)) return markerPath(value[0], marker, prefix)
  if (!isTable(value)) return undefined
  for (const [key, child] of Object.entries(value)) {
    if (key === marker) return prefix
    const result = markerPath(child, marker, [...prefix, key])
    if (result) return result
  }
  return undefined
}

/** @param {string[]} lines @returns {Section[]} */
function sections(lines) {
  /** @type {Section[]} */
  const result = [{ start: -1, end: lines.length, path: [], array: false }]
  const marker = "__copilot_api_setup_table_marker__"
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    if (!line.startsWith("[")) continue
    let tablePath
    try {
      tablePath = markerPath(TOML.parse(`${line}\n${marker} = true`), marker)
    } catch {
      continue // A continuation line in an unrelated array is not a table header.
    }
    if (!tablePath) continue
    result[result.length - 1].end = index
    result.push({
      start: index,
      end: lines.length,
      path: tablePath,
      array: line.startsWith("[["),
    })
  }
  return result
}

/** @param {string} line @returns {{key: string, raw: string} | undefined} */
function assignment(line) {
  const match = /^(\s*)((?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))\s*=/.exec(
    line,
  )
  if (!match) return undefined
  const parsed = TOML.parse(`${match[2]} = true`)
  return { key: Object.keys(parsed)[0], raw: `${match[1]}${match[2]}` }
}

/** @param {string[]} lines @param {number} start @param {number} end */
function assignmentEnd(lines, start, end) {
  for (let index = start + 1; index <= end; index++) {
    try {
      TOML.parse(lines.slice(start, index).join("\n"))
      return index
    } catch {
      // A targeted multiline array must be replaced as one complete value.
    }
  }
  throw new Error("Cannot safely update Codex TOML: ambiguous assignment")
}

/** @param {string} line */
function inlineComment(line) {
  let quote = ""
  let escaped = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (quote === '"' && char === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = ""
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === "#") return ` ${line.slice(index)}`
  }
  return ""
}

/** Update the active Copilot provider without serializing unrelated TOML.
 * Unsupported ambiguous syntax is rejected before installation writes files.
 * @param {string} source @param {ConfigOptions} [options] @returns {string}
 */
export function mergeCodexConfig(source, options = {}) {
  const original = parseConfig(source)
  if (/'''|"""/.test(source)) {
    throw new Error(
      "Cannot safely update Codex TOML: multiline strings require a manual edit",
    )
  }
  const expected = structuredClone(original)
  if (
    expected.model_providers !== undefined
    && !isTable(expected.model_providers)
  ) {
    throw new Error(
      "Cannot safely update Codex TOML: model_providers is not a table",
    )
  }
  const providers = /** @type {Table} */ (expected.model_providers ?? {})
  if (providers[providerId] !== undefined && !isTable(providers[providerId])) {
    throw new Error(
      "Cannot safely update Codex TOML: the selected provider is not a table",
    )
  }
  const provider = /** @type {Table} */ (providers[providerId] ?? {})
  const baseUrl =
    options.url === undefined ?
      (provider.base_url ?? defaultUrl)
    : normalizeUrl(options.url)
  if (typeof baseUrl !== "string")
    throw new Error("Cannot safely update Codex TOML: invalid provider URL")
  normalizeUrl(baseUrl)
  const model =
    options.model
    ?? ((
      original.model_provider === providerId
      && typeof original.model === "string"
    ) ?
      original.model
    : defaultModel)
  if (!model.trim() || /[\r\n]/.test(model))
    throw new Error("Model must be a nonempty single-line identifier")
  expected.model_provider = providerId
  expected.model = model
  expected.model_reasoning_effort ??= "medium"
  expected.web_search ??= "disabled"
  delete expected.service_tier
  Object.assign(provider, {
    name: "Copilot API",
    base_url: baseUrl,
    model_catalog_url:
      options.url === undefined ?
        (provider.model_catalog_url ?? `${baseUrl.replace(/\/+$/, "")}/models`)
      : `${baseUrl}/models`,
    wire_api: "responses",
    requires_openai_auth: true,
  })
  provider.supports_websockets ??= false
  provider.request_max_retries ??= 2
  provider.stream_max_retries ??= 2
  provider.stream_idle_timeout_ms ??= 300000
  delete provider.auth
  delete provider.env_key
  delete provider.experimental_bearer_token
  for (const key of ["http_headers", "env_http_headers"]) {
    if (provider[key] !== undefined && !isTable(provider[key])) {
      throw new Error(
        "Cannot safely update Codex TOML: provider headers are not a table",
      )
    }
    if (key === "env_http_headers") provider[key] ??= {}
    if (!isTable(provider[key])) continue
    for (const header of Object.keys(provider[key])) {
      if (header.toLowerCase() === "x-api-key") delete provider[key][header]
    }
  }
  /** @type {Table} */ provider.env_http_headers["x-api-key"] =
    "COPILOT_API_GATEWAY_KEY"
  providers[providerId] = provider
  expected.model_providers = providers

  const newline = source.includes("\r\n") ? "\r\n" : "\n"
  const lines = source ? source.replace(/\r\n/g, "\n").split("\n") : []
  const tables = sections(lines)
  /** @type {Edit[]} */
  const edits = []
  /** @type {string[]} */
  const appended = []
  const providerPath = ["model_providers", providerId]
  /** @param {string[]} tablePath @param {Table} before @param {Table} after */
  function patchTable(tablePath, before, after) {
    const changes = new Map(
      Object.keys({ ...before, ...after })
        .filter((key) => !isDeepStrictEqual(before[key], after[key]))
        .map((key) => [key, key in after ? after[key] : remove]),
    )
    if (!changes.size) return
    const candidates = tables.filter((section) =>
      isDeepStrictEqual(section.path, tablePath),
    )
    if (candidates.length > 1 || candidates.some((section) => section.array)) {
      throw new Error("Cannot safely update Codex TOML: ambiguous table")
    }
    const section = candidates[0]
    if (!section) {
      appended.push("", `[${tablePath.map(tomlKey).join(".")}]`)
      for (const [key, value] of changes)
        if (value !== remove)
          appended.push(`${tomlKey(key)} = ${tomlValue(value)}`)
      return
    }
    for (let index = section.start + 1; index < section.end; index++) {
      const item = assignment(lines[index])
      if (!item || !changes.has(item.key)) continue
      const end = assignmentEnd(lines, index, section.end)
      const value = changes.get(item.key)
      edits.push({
        start: index,
        end,
        lines:
          value === remove ?
            []
          : [
              `${item.raw} = ${tomlValue(value)}${inlineComment(lines[end - 1])}`,
            ],
      })
      changes.delete(item.key)
      index = end - 1
    }
    const additions = [...changes]
      .filter(([, value]) => value !== remove)
      .map(([key, value]) => `${tomlKey(key)} = ${tomlValue(value)}`)
    if (additions.length)
      edits.push({ start: section.end, end: section.end, lines: additions })
  }
  const oldProvider =
    (
      isTable(original.model_providers)
      && isTable(original.model_providers[providerId])
    ) ?
      original.model_providers[providerId]
    : {}
  const beforeProvider = { ...oldProvider }
  const afterProvider = { ...provider }
  for (const key of ["http_headers", "env_http_headers"]) {
    if (
      !tables.some((section) =>
        isDeepStrictEqual(section.path, [...providerPath, key]),
      )
    )
      continue
    patchTable(
      [...providerPath, key],
      isTable(beforeProvider[key]) ? beforeProvider[key] : {},
      isTable(afterProvider[key]) ? afterProvider[key] : {},
    )
    delete beforeProvider[key]
    delete afterProvider[key]
  }
  patchTable([], original, {
    ...expected,
    model_providers: original.model_providers,
  })
  patchTable(providerPath, beforeProvider, afterProvider)
  for (const section of tables) {
    if (
      providerPath.every((part, index) => section.path[index] === part)
      && section.path[2] === "auth"
    ) {
      edits.push({ start: section.start, end: section.end, lines: [] })
    }
  }
  for (const edit of edits.sort(
    (left, right) => right.start - left.start || right.end - left.end,
  )) {
    lines.splice(edit.start, edit.end - edit.start, ...edit.lines)
  }
  if (appended.length) lines.push(...appended)
  const output = lines.join(newline)
  let parsed
  try {
    parsed = TOML.parse(output)
  } catch {
    throw new Error(
      "Cannot safely update Codex TOML: unsupported table or key syntax",
    )
  }
  if (!isDeepStrictEqual(parsed, expected)) {
    throw new Error(
      "Cannot safely update Codex TOML: unsupported table or key syntax",
    )
  }
  return output
}

/** @param {string} value */
function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** A sourceable helper; sourcing alone never exports credentials.
 * @param {string} [defaultGatewayHome] @param {string} [baseUrl] @returns {string}
 */
export function gatewayEnvScript(defaultGatewayHome, baseUrl = defaultUrl) {
  const fallback =
    defaultGatewayHome === undefined ?
      '"$HOME/.local/share/copilot-api"'
    : shellQuote(defaultGatewayHome)
  return `# Generated by copilot-api setup; the gateway key stays in its private file.
copilot_api_load_gateway_key() {
    copilot_api_gateway_home="\${COPILOT_API_HOME:-}"
    if [ -z "$copilot_api_gateway_home" ]; then
        copilot_api_gateway_home=${fallback}
    fi
    if [ ! -r "$copilot_api_gateway_home/gateway_key" ]; then
        printf '%s\\n' 'Gateway key file is missing or unreadable' >&2
        unset COPILOT_API_GATEWAY_KEY
        return 1
    fi
    if ! COPILOT_API_GATEWAY_KEY="$(cat "$copilot_api_gateway_home/gateway_key")"; then
        printf '%s\\n' 'Gateway key file is missing or unreadable' >&2
        unset COPILOT_API_GATEWAY_KEY
        return 1
    fi
    if [ -z "$(printf '%s' "$COPILOT_API_GATEWAY_KEY" | tr -d '[:space:]')" ]; then
        printf '%s\\n' 'Gateway key file is empty' >&2
        unset COPILOT_API_GATEWAY_KEY
        return 1
    fi
    export COPILOT_API_GATEWAY_KEY
    if [ -z "\${COPILOT_API_BASE_URL:-}" ]; then
        COPILOT_API_BASE_URL=${shellQuote(baseUrl)}
    fi
    export COPILOT_API_BASE_URL
    unset copilot_api_gateway_home
}
`
}

/** @param {string} source @returns {string} */
export function updateShellProfile(source) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n"
  const block = `${beginMarker}
if [ "\${CODEX_INTERNAL_ORIGINATOR_OVERRIDE:-}" = "Codex Desktop" ]; then
    . "$HOME/.config/copilot-api/codex-env.sh"
    copilot_api_load_gateway_key
fi
${endMarker}`.replaceAll("\n", newline)
  const starts = source.split(beginMarker).length - 1
  const ends = source.split(endMarker).length - 1
  if (!starts && !ends)
    return `${source}${source && !source.endsWith("\n") ? newline : ""}${source ? newline : ""}${block}${newline}`
  if (
    starts !== 1
    || ends !== 1
    || source.indexOf(endMarker) < source.indexOf(beginMarker)
  ) {
    throw new Error(
      "Cannot safely update the shell profile: ambiguous setup markers",
    )
  }
  return (
    source.slice(0, source.indexOf(beginMarker))
    + block
    + source.slice(source.indexOf(endMarker) + endMarker.length)
  )
}

/** @typedef {{home?: string, codexHome?: string, configPath?: string, gatewayHome?: string, model?: string, url?: string, cli?: boolean, dryRun?: boolean, env?: Record<string, string | undefined>, resolveWindowsHome?: () => string}} InstallOptions */

function windowsHome() {
  try {
    const windowsPath = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Environment]::GetFolderPath('UserProfile')",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim()
    if (!windowsPath) throw new Error("No Windows profile")
    return execFileSync("wslpath", ["-u", windowsPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch {
    throw new Error(
      "Cannot locate Windows Codex settings; use --cli or --codex-home PATH",
    )
  }
}

/** @param {string} filename @returns {{text: string, mode: number, exists: boolean}} */
function readOptional(filename) {
  try {
    const stat = fs.lstatSync(filename)
    if (!stat.isFile()) throw new Error("Setup targets must be regular files")
    return {
      text: fs.readFileSync(filename, "utf8"),
      mode: stat.mode & 0o777,
      exists: true,
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { text: "", mode: 0o600, exists: false }
    throw new Error(
      "Cannot read a setup target; check its path and permissions",
    )
  }
}

/** Install only local configuration and launch helpers; never authenticate or start services.
 * @param {InstallOptions} [options]
 * @returns {{configPath: string, profilePath: string, changedFiles: string[], backupFiles: string[]}}
 */
export function installCodexSetup(options = {}) {
  const env = options.env ?? process.env
  const home = path.resolve(options.home ?? os.homedir())
  const configPath = path.resolve(
    options.configPath
      ?? path.join(
        options.codexHome
          ?? env.CODEX_HOME
          ?? (options.cli ?
            path.join(home, ".codex")
          : path.join((options.resolveWindowsHome ?? windowsHome)(), ".codex")),
        "config.toml",
      ),
  )
  const gatewayHome = path.resolve(
    options.gatewayHome
      ?? env.COPILOT_API_HOME
      ?? path.join(home, ".local/share/copilot-api"),
  )
  let gatewayKey
  try {
    gatewayKey = fs
      .readFileSync(path.join(gatewayHome, "gateway_key"), "utf8")
      .trim()
  } catch {
    throw new Error(
      "Gateway key file is missing or unreadable; start and authenticate copilot-api first",
    )
  }
  if (!gatewayKey)
    throw new Error(
      "Gateway key file is empty; start and authenticate copilot-api first",
    )
  const profilePath =
    [".bash_profile", ".bash_login", ".profile"]
      .map((filename) => path.join(home, filename))
      .find((filename) => fs.existsSync(filename))
    ?? path.join(home, ".profile")
  const helperPath = path.join(home, ".config/copilot-api/codex-env.sh")
  const launcherPath = path.join(home, ".local/bin/codex-copilot-api")
  const config = readOptional(configPath)
  const merged = mergeCodexConfig(config.text, options)
  const parsed = parseConfig(merged)
  const provider = /** @type {Table} */ (
    /** @type {Table} */ (parsed.model_providers)[providerId]
  )
  const profile = readOptional(profilePath)
  const helper = readOptional(helperPath)
  const launcher = readOptional(launcherPath)
  const gatewayDefault =
    gatewayHome === path.join(home, ".local/share/copilot-api") ?
      undefined
    : gatewayHome
  const files = [
    { filename: configPath, before: config, text: merged, mode: 0o600 },
    {
      filename: helperPath,
      before: helper,
      text: gatewayEnvScript(
        gatewayDefault,
        /** @type {string} */ (provider.base_url),
      ),
      mode: 0o600,
    },
    {
      filename: profilePath,
      before: profile,
      text: updateShellProfile(profile.text),
      mode: profile.exists ? profile.mode : 0o644,
    },
    {
      filename: launcherPath,
      before: launcher,
      text: fs.readFileSync(
        new URL("./codex-copilot-api", import.meta.url),
        "utf8",
      ),
      mode: 0o755,
    },
  ].filter((file) => !file.before.exists || file.before.text !== file.text)
  const result = {
    configPath,
    profilePath,
    changedFiles: files.map((file) => file.filename),
    backupFiles: /** @type {string[]} */ ([]),
  }
  if (options.dryRun) return result
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const backupDirectory = path.join(
    home,
    ".local/state/copilot-api/codex-setup",
    runId,
  )
  for (const file of files) {
    fs.mkdirSync(path.dirname(file.filename), { recursive: true, mode: 0o700 })
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const temporary = `${file.filename}.copilot-api-${suffix}.tmp`
    try {
      fs.writeFileSync(temporary, file.text, { mode: file.mode, flag: "wx" })
      fs.chmodSync(temporary, file.mode)
      if (file.before.exists) {
        fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 })
        fs.chmodSync(backupDirectory, 0o700)
        const backup = path.join(
          backupDirectory,
          `${result.backupFiles.length}-${path.basename(file.filename)}`,
        )
        fs.writeFileSync(backup, file.before.text, { mode: 0o600, flag: "wx" })
        fs.chmodSync(backup, 0o600)
        result.backupFiles.push(backup)
      }
      fs.renameSync(temporary, file.filename)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }
  return result
}

/** @param {string[]} args @returns {InstallOptions & {help?: boolean}} */
export function parseArgs(args) {
  /** @type {InstallOptions & {help?: boolean}} */
  const options = {}
  const valueFlags = new Map([
    ["--codex-home", "codexHome"],
    ["--gateway-home", "gatewayHome"],
    ["--model", "model"],
    ["--url", "url"],
  ])
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === "--help" || argument === "-h") options.help = true
    else if (argument === "--cli") options.cli = true
    else if (argument === "--dry-run") options.dryRun = true
    else if (valueFlags.has(argument)) {
      const value = args[++index]
      if (!value || value.startsWith("--"))
        throw new Error("An installer option is missing its value; use --help")
      options[valueFlags.get(argument)] = value
    } else throw new Error("Unknown installer option; use --help")
  }
  return options
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      console.log(
        "Usage: bun deploy/local/setup-codex.mjs [--cli | --codex-home PATH] [--gateway-home PATH] [--model MODEL] [--url URL] [--dry-run]\nDefault: configure Windows Codex from WSL; CODEX_HOME overrides discovery.\nThe gateway must already have a nonempty gateway_key. No sign-in or service restart is performed.",
      )
    } else {
      const result = installCodexSetup(options)
      console.log(
        `${options.dryRun ? "Would update" : "Updated"} ${result.changedFiles.length} files.\nCodex config: ${result.configPath}\nBash startup: ${result.profilePath}\nBackups: ${result.backupFiles.length}`,
      )
      for (const filename of result.changedFiles) console.log(`  ${filename}`)
      for (const filename of result.backupFiles)
        console.log(`Backup: ${filename}`)
      if (!options.dryRun) {
        console.log(
          options.cli ?
            "Start the gateway, then run codex-copilot-api."
          : "Next: start the gateway, fully quit and reopen Codex Desktop, sign in to ChatGPT, then pair your phone in Settings > Connections > Control this PC.",
        )
      }
    }
  } catch (error) {
    // Only installer-authored messages are emitted; filesystem/subprocess errors may contain secrets.
    const message =
      (
        error instanceof Error
        && /^(Invalid Codex TOML|Cannot safely update|Gateway key file|Cannot locate Windows|Gateway URL must|Model must|An installer option|Unknown installer option|Refusing to copy)/.test(
          error.message,
        )
      ) ?
        error.message
      : "Setup failed; check target paths and permissions"
    console.error(message)
    process.exitCode = 1
  }
}
