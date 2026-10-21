import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  gatewayEnvScript,
  installCodexSetup,
  mergeCodexConfig,
  parseArgs,
  updateShellProfile,
} from "../deploy/local/setup-codex.mjs"

type CodexConfig = {
  model?: string
  model_provider?: string
  model_reasoning_effort?: string
  service_tier?: string
  model_providers: Record<string, Record<string, unknown>>
  desktop?: Record<string, unknown>
  mcp_servers?: Record<string, unknown>
}

const repository = path.resolve(import.meta.dir, "..")
const temporaryDirectories: Array<string> = []

function parseConfig(source: string): CodexConfig {
  return Bun.TOML.parse(source) as CodexConfig
}

function fixture(config?: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-local-setup-"))
  temporaryDirectories.push(directory)
  const home = path.join(directory, "device home 'quoted")
  const codexHome = path.join(directory, "codex settings")
  const gatewayHome = path.join(directory, "gateway state")
  const configPath = path.join(codexHome, "config.toml")
  const profilePath = path.join(home, ".profile")
  const helperPath = path.join(home, ".config", "copilot-api", "codex-env.sh")
  const keyPath = path.join(gatewayHome, "gateway_key")
  for (const target of [home, codexHome, gatewayHome]) {
    fs.mkdirSync(target, { recursive: true })
  }
  fs.writeFileSync(keyPath, "fixture-gateway-key\n", { mode: 0o600 })
  if (config !== undefined) {
    fs.writeFileSync(configPath, config, { mode: 0o600 })
  }
  return {
    directory,
    home,
    codexHome,
    gatewayHome,
    configPath,
    profilePath,
    helperPath,
    keyPath,
    run: (options: Record<string, unknown> = {}) =>
      installCodexSetup({ home, codexHome, gatewayHome, ...options }),
  }
}

type Fixture = ReturnType<typeof fixture>

function shellEnvironment(f: Fixture, additions: NodeJS.ProcessEnv = {}) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: f.home,
    COPILOT_API_HOME: f.gatewayHome,
    ...additions,
  }
  delete environment.COPILOT_API_GATEWAY_KEY
  if (!("CODEX_INTERNAL_ORIGINATOR_OVERRIDE" in additions)) {
    delete environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE
  }
  return environment
}

function readProfileInLoginShell(
  f: Fixture,
  desktop: boolean,
  sourcePath = f.profilePath,
) {
  const capture = path.join(f.directory, "exported-key")
  const script = `. "$1"; exec "$2" -e 'require("node:fs").writeFileSync(process.env.SETUP_CAPTURE, process.env.COPILOT_API_GATEWAY_KEY ?? "")'`
  const result = Bun.spawnSync(
    [
      "/usr/bin/bash",
      "--noprofile",
      "-lc",
      script,
      "codex-setup-test",
      sourcePath,
      process.execPath,
    ],
    {
      env: shellEnvironment(f, {
        SETUP_CAPTURE: capture,
        ...(desktop ?
          { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }
        : {}),
      }),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  return {
    exit: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
    key: fs.existsSync(capture) ? fs.readFileSync(capture, "utf8") : undefined,
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe("Codex local Remote Control configuration", () => {
  test("separates ChatGPT account authentication from the gateway key", () => {
    const config = parseConfig(mergeCodexConfig(""))
    expect(config.model_provider).toBe("copilot-api-community")
    expect(config.model).toBe("copilot-cli/gpt-6.1-sol")
    expect(config.model_providers["copilot-api-community"]).toMatchObject({
      name: "Copilot API",
      base_url: "http://127.0.0.1:4141",
      model_catalog_url: "http://127.0.0.1:4141/models",
      wire_api: "responses",
      requires_openai_auth: true,
      env_http_headers: { "x-api-key": "COPILOT_API_GATEWAY_KEY" },
    })
    expect(config.model_providers["copilot-api-community"]).not.toHaveProperty(
      "auth",
    )
  })

  test("preserves unrelated settings and explicit provider preferences", () => {
    const source = `# User preferences remain local.
model = "previous-model"
model_provider = "previous-provider"
model_reasoning_effort = "ultra"
service_tier = "fast"

[model_providers.other]
name = "Other provider"
base_url = "https://other.example.test/v1"

[model_providers.copilot-api-community]
name = "Old name"
base_url = "http://127.0.0.1:5151"
model_catalog_url = "http://127.0.0.1:5151/custom-models"
wire_api = "responses"
stream_idle_timeout_ms = 987654
request_max_retries = 7

[model_providers.copilot-api-community.auth]
command = "/old/device/credential-helper"
args = ["print-key"]

[desktop]
appearanceTheme = "dark"

[mcp_servers.example]
command = "example-mcp"
`
    const config = parseConfig(mergeCodexConfig(source))
    expect(config.model_reasoning_effort).toBe("ultra")
    expect(config).not.toHaveProperty("service_tier")
    expect(config.model_providers.other).toEqual({
      name: "Other provider",
      base_url: "https://other.example.test/v1",
    })
    expect(config.model_providers["copilot-api-community"]).toMatchObject({
      base_url: "http://127.0.0.1:5151",
      model_catalog_url: "http://127.0.0.1:5151/custom-models",
      stream_idle_timeout_ms: 987654,
      request_max_retries: 7,
    })
    expect(config.model_providers["copilot-api-community"]).not.toHaveProperty(
      "auth",
    )
    expect(config.desktop).toEqual({ appearanceTheme: "dark" })
    expect(config.mcp_servers).toEqual({
      example: { command: "example-mcp" },
    })
  })

  test("honors an explicit model and gateway URL", () => {
    const config = parseConfig(
      mergeCodexConfig("", {
        model: "copilot-cli/custom-model",
        url: "http://127.0.0.1:5151/",
      }),
    )
    expect(config.model).toBe("copilot-cli/custom-model")
    expect(config.model_providers["copilot-api-community"]).toMatchObject({
      base_url: "http://127.0.0.1:5151",
      model_catalog_url: "http://127.0.0.1:5151/models",
    })
  })

  test("preserves the user's model when the gateway is already selected", () => {
    const source = `model_provider = "copilot-api-community"
model = "copilot-cli/selected-model"

[model_providers.copilot-api-community]
name = "Copilot API"
`
    expect(parseConfig(mergeCodexConfig(source)).model).toBe(
      "copilot-cli/selected-model",
    )
  })

  test("migrates existing gateway headers while preserving unrelated headers", () => {
    const source = `[model_providers."copilot-api-community"]
env_key = "LEGACY_KEY"
experimental_bearer_token = "legacy-fixture-token"

[model_providers."copilot-api-community".http_headers]
"X-API-Key" = "old-fixture-key"
"X-Client" = "example-client"

[model_providers."copilot-api-community".env_http_headers]
"X-API-KEY" = "OLD_GATEWAY_ENV"
"X-Trace" = "TRACE_ENV"
`
    const provider = parseConfig(mergeCodexConfig(source)).model_providers[
      "copilot-api-community"
    ]
    expect(provider).not.toHaveProperty("env_key")
    expect(provider).not.toHaveProperty("experimental_bearer_token")
    expect(provider.http_headers).toEqual({ "X-Client": "example-client" })
    expect(provider.env_http_headers).toEqual({
      "X-Trace": "TRACE_ENV",
      "x-api-key": "COPILOT_API_GATEWAY_KEY",
    })
  })

  test("does not rewrite an already configured document", () => {
    const configured = mergeCodexConfig("# Keep this comment.\n")
    expect(mergeCodexConfig(configured)).toBe(configured)
  })

  test("rejects malformed TOML", () => {
    expect(() => mergeCodexConfig('model = "unterminated')).toThrow(
      "Invalid Codex TOML",
    )
  })

  test("rejects duplicate provider definitions", () => {
    expect(() =>
      mergeCodexConfig(
        "[model_providers.copilot-api-community]\nname = 'One'\n"
          + "[model_providers.copilot-api-community]\nname = 'Two'\n",
      ),
    ).toThrow()
  })

  test("adds the shell hook once while preserving the user's profile", () => {
    const original = '# Existing setup.\nexport EDITOR="vi"\n'
    const updated = updateShellProfile(original)
    expect(updated).toContain(original.trim())
    expect(updated).toContain("codex-env.sh")
    expect(updateShellProfile(updated)).toBe(updated)
    expect(gatewayEnvScript()).not.toContain("/home/boren")
  })

  test("rejects a partial previous shell hook", () => {
    expect(() =>
      updateShellProfile("# >>> copilot-api Codex Desktop >>>\n# incomplete\n"),
    ).toThrow("ambiguous setup markers")
  })

  test("parses installer flags without evaluating their values", () => {
    expect(
      parseArgs([
        "--cli",
        "--dry-run",
        "--codex-home",
        "/device settings/$(literal)",
        "--gateway-home",
        "/gateway data",
        "--model",
        "copilot-cli/custom-model",
        "--url",
        "http://127.0.0.1:5151",
      ]),
    ).toEqual({
      cli: true,
      dryRun: true,
      codexHome: "/device settings/$(literal)",
      gatewayHome: "/gateway data",
      model: "copilot-cli/custom-model",
      url: "http://127.0.0.1:5151",
    })
    expect(parseArgs(["--help"])).toEqual({ help: true })
  })

  test.each([
    { args: ["--model"] },
    { args: ["--model", "--cli"] },
    { args: ["--unknown"] },
  ])("rejects invalid installer arguments $args", ({ args }) => {
    expect(() => parseArgs(args)).toThrow("installer option")
  })
})

describe("Codex local setup installation", () => {
  test("installs a fresh device without writing credentials to setup files", () => {
    const f = fixture()
    const result = f.run()
    expect(result.configPath).toBe(f.configPath)
    expect(result.profilePath).toBe(f.profilePath)
    expect(result.changedFiles).toContain(f.configPath)
    expect(result.changedFiles).toContain(f.profilePath)
    expect(result.changedFiles).toContain(f.helperPath)
    expect(result.backupFiles).toEqual([])
    expect(
      parseConfig(fs.readFileSync(f.configPath, "utf8")).model_provider,
    ).toBe("copilot-api-community")
    for (const filename of result.changedFiles) {
      expect(fs.readFileSync(filename, "utf8")).not.toContain(
        "fixture-gateway-key",
      )
    }
    expect(JSON.stringify(result)).not.toContain("fixture-gateway-key")
    expect(fs.readFileSync(f.keyPath, "utf8")).toBe("fixture-gateway-key\n")
  })

  test("backs up changed existing files and does nothing on a second run", () => {
    const originalConfig = 'model_reasoning_effort = "ultra"\n'
    const originalProfile = '# Existing user profile.\nexport EDITOR="vi"\n'
    const f = fixture(originalConfig)
    fs.writeFileSync(f.profilePath, originalProfile)
    const first = f.run()
    expect(first.backupFiles.length).toBeGreaterThanOrEqual(2)
    const backupContents = first.backupFiles.map((filename: string) => {
      expect(fs.statSync(filename).mode & 0o777).toBe(0o600)
      expect(filename.startsWith(path.join(f.home, ".local", "state"))).toBe(
        true,
      )
      return fs.readFileSync(filename, "utf8")
    })
    expect(backupContents).toContain(originalConfig)
    expect(backupContents).toContain(originalProfile)
    const configured = fs.readFileSync(f.configPath, "utf8")
    const profile = fs.readFileSync(f.profilePath, "utf8")
    const second = f.run()
    expect(second.changedFiles).toEqual([])
    expect(second.backupFiles).toEqual([])
    expect(fs.readFileSync(f.configPath, "utf8")).toBe(configured)
    expect(fs.readFileSync(f.profilePath, "utf8")).toBe(profile)
  })

  test("dry run leaves existing files untouched", () => {
    const source = 'model_reasoning_effort = "high"\n'
    const f = fixture(source)
    const result = f.run({ dryRun: true })
    expect(result.changedFiles).toContain(f.configPath)
    expect(result.backupFiles).toEqual([])
    expect(fs.readFileSync(f.configPath, "utf8")).toBe(source)
    expect(fs.existsSync(f.profilePath)).toBe(false)
    expect(fs.existsSync(f.helperPath)).toBe(false)
  })

  test("honors CODEX_HOME and discovers the Windows profile when unset", () => {
    const f = fixture()
    let discoveries = 0
    const options = {
      home: f.home,
      gatewayHome: f.gatewayHome,
      resolveWindowsHome: () => {
        discoveries++
        return path.join(f.directory, "Windows user")
      },
    }
    const configured = installCodexSetup({
      ...options,
      env: { CODEX_HOME: f.codexHome },
    })
    expect(configured.configPath).toBe(f.configPath)
    expect(discoveries).toBe(0)
    const discovered = installCodexSetup({ ...options, env: {} })
    expect(discoveries).toBe(1)
    expect(discovered.configPath).toBe(
      path.join(f.directory, "Windows user", ".codex", "config.toml"),
    )
    const cli = installCodexSetup({ ...options, env: {}, cli: true })
    expect(discoveries).toBe(1)
    expect(cli.configPath).toBe(path.join(f.home, ".codex", "config.toml"))
  })

  test("does not discover Windows when an explicit config path is supplied", () => {
    const f = fixture()
    const result = installCodexSetup({
      home: f.home,
      configPath: f.configPath,
      gatewayHome: f.gatewayHome,
      env: {},
      resolveWindowsHome: () => {
        throw new Error("Windows discovery must not run")
      },
    })
    expect(result.configPath).toBe(f.configPath)
    expect(fs.existsSync(f.configPath)).toBe(true)
  })

  test("accepts a short existing gateway key", () => {
    const f = fixture()
    fs.writeFileSync(f.keyPath, "api\n")
    expect(f.run().changedFiles).toContain(f.configPath)
    expect(fs.readFileSync(f.keyPath, "utf8")).toBe("api\n")
  })

  test.each(["missing", "empty"])(
    "does not change existing settings when the key is %s",
    (kind) => {
      const source = '# Preserve this config.\nmodel = "existing-model"\n'
      const f = fixture(source)
      fs.writeFileSync(f.profilePath, "# Preserve this profile.\n")
      if (kind === "missing") fs.unlinkSync(f.keyPath)
      else fs.writeFileSync(f.keyPath, " \n\t")
      expect(() => f.run()).toThrow(
        kind === "missing" ? "missing or unreadable" : "empty",
      )
      expect(fs.readFileSync(f.configPath, "utf8")).toBe(source)
      expect(fs.readFileSync(f.profilePath, "utf8")).toBe(
        "# Preserve this profile.\n",
      )
      expect(fs.existsSync(f.helperPath)).toBe(false)
    },
  )

  test("rejects invalid existing TOML before changing any setup files", () => {
    const source = 'model = "broken\n'
    const f = fixture(source)
    expect(() => f.run()).toThrow("Invalid Codex TOML")
    expect(fs.readFileSync(f.configPath, "utf8")).toBe(source)
    expect(fs.existsSync(f.profilePath)).toBe(false)
    expect(fs.existsSync(f.helperPath)).toBe(false)
  })

  test("rejects ambiguous provider layout before changing any setup files", () => {
    const source =
      'model_providers.copilot-api-community = { name = "Inline provider" }\n'
    const f = fixture(source)
    expect(() => f.run()).toThrow("Cannot safely update Codex TOML")
    expect(fs.readFileSync(f.configPath, "utf8")).toBe(source)
    expect(fs.existsSync(f.profilePath)).toBe(false)
    expect(fs.existsSync(f.helperPath)).toBe(false)
  })

  test("does not replace a symlink to an existing Codex config", () => {
    const f = fixture()
    const target = path.join(f.directory, "shared-config.toml")
    const source = 'model = "shared-model"\n'
    fs.writeFileSync(target, source)
    fs.symlinkSync(target, f.configPath)
    expect(() => f.run()).toThrow("Cannot read a setup target")
    expect(fs.lstatSync(f.configPath).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(target, "utf8")).toBe(source)
    expect(fs.existsSync(f.helperPath)).toBe(false)
    expect(fs.existsSync(f.profilePath)).toBe(false)
  })

  test("loads the existing key in a desktop login shell without evaluating it", () => {
    const f = fixture()
    const marker = path.join(f.directory, "must-not-exist")
    const key = `fixture-$(touch '${marker}')-\`false\`-$literal`
    fs.writeFileSync(f.keyPath, key + "\n")
    f.run()
    const result = readProfileInLoginShell(f, true)
    expect(result.exit).toBe(0)
    expect(result.key).toBe(key)
    expect(result.output).not.toContain(key)
    expect(fs.existsSync(marker)).toBe(false)
  })

  test("does not export the gateway key for ordinary login shells", () => {
    const f = fixture()
    f.run()
    const result = readProfileInLoginShell(f, false)
    expect(result.exit).toBe(0)
    expect(result.key).toBe("")
    expect(result.output).not.toContain("fixture-gateway-key")
  })

  test("sourcing the helper alone does not export credentials", () => {
    const f = fixture()
    f.run()
    const result = readProfileInLoginShell(f, false, f.helperPath)
    expect(result.exit).toBe(0)
    expect(result.key).toBe("")
    expect(result.output).not.toContain("fixture-gateway-key")
  })
})

function launcherFixture(f: Fixture) {
  const bin = path.join(f.directory, "fake-bin")
  fs.mkdirSync(bin)
  const capture = path.join(f.directory, "codex-invocation")
  const curlCapture = path.join(f.directory, "health-invocation")
  fs.writeFileSync(
    path.join(bin, "codex"),
    '#!/bin/sh\nprintf "%s\\0" "$CODEX_HOME" "$COPILOT_API_GATEWAY_KEY" "$@" > "$SETUP_CAPTURE"\n',
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(bin, "curl"),
    '#!/bin/sh\nprintf "%s\\0" "$@" > "$SETUP_CURL_CAPTURE"\nexit "${SETUP_CURL_EXIT:-0}"\n',
    { mode: 0o755 },
  )
  return {
    capture,
    curlCapture,
    run: (args: Array<string> = [], additions: NodeJS.ProcessEnv = {}) => {
      const result = Bun.spawnSync(
        [
          "/bin/sh",
          path.join(repository, "deploy/local/codex-copilot-api"),
          ...args,
        ],
        {
          env: shellEnvironment(f, {
            PATH: bin + path.delimiter + (process.env.PATH ?? ""),
            SETUP_CAPTURE: capture,
            SETUP_CURL_CAPTURE: curlCapture,
            ...additions,
          }),
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      return {
        exit: result.exitCode,
        output: result.stdout.toString() + result.stderr.toString(),
      }
    },
  }
}

describe("Codex Copilot launcher", () => {
  test("preserves CODEX_HOME, loads the key and forwards arguments unchanged", () => {
    const f = fixture()
    f.run()
    const launcher = launcherFixture(f)
    const args = ["exec", "prompt with spaces", "--config", 'example="literal"']
    const result = launcher.run(args, {
      CODEX_HOME: f.codexHome,
      COPILOT_API_BASE_URL: "http://127.0.0.1:5151",
    })
    expect(result.exit).toBe(0)
    expect(result.output).not.toContain("fixture-gateway-key")
    expect(fs.readFileSync(launcher.capture, "utf8").split("\0")).toEqual([
      f.codexHome,
      "fixture-gateway-key",
      ...args,
      "",
    ])
    const healthArguments = fs
      .readFileSync(launcher.curlCapture, "utf8")
      .split("\0")
    expect(healthArguments).toContain("http://127.0.0.1:5151/")
    expect(healthArguments).not.toContain("fixture-gateway-key")
  })

  test("defaults CODEX_HOME to the user's Codex directory", () => {
    const f = fixture()
    f.run()
    const launcher = launcherFixture(f)
    const result = launcher.run([], { CODEX_HOME: undefined })
    expect(result.exit).toBe(0)
    expect(fs.readFileSync(launcher.capture, "utf8").split("\0")[0]).toBe(
      path.join(f.home, ".codex"),
    )
  })

  test("honors a gateway state directory override at launch time", () => {
    const f = fixture()
    f.run()
    const override = path.join(f.directory, "another gateway")
    fs.mkdirSync(override)
    fs.writeFileSync(
      path.join(override, "gateway_key"),
      "override-fixture-key\n",
    )
    const launcher = launcherFixture(f)
    const result = launcher.run([], { COPILOT_API_HOME: override })
    expect(result.exit).toBe(0)
    expect(fs.readFileSync(launcher.capture, "utf8").split("\0")[1]).toBe(
      "override-fixture-key",
    )
    expect(result.output).not.toContain("override-fixture-key")
  })

  test("normalizes a trailing slash before checking gateway health", () => {
    const f = fixture()
    f.run()
    const launcher = launcherFixture(f)
    const result = launcher.run([], {
      COPILOT_API_BASE_URL: "http://127.0.0.1:5151/",
    })
    expect(result.exit).toBe(0)
    expect(fs.readFileSync(launcher.curlCapture, "utf8").split("\0")).toContain(
      "http://127.0.0.1:5151/",
    )
    expect(fs.readFileSync(launcher.curlCapture, "utf8")).not.toContain(
      "http://127.0.0.1:5151//",
    )
  })

  test("reports a missing setup helper before launching Codex", () => {
    const f = fixture()
    const launcher = launcherFixture(f)
    const result = launcher.run()
    expect(result.exit).not.toBe(0)
    expect(result.output).toContain("setup:codex")
    expect(fs.existsSync(launcher.capture)).toBe(false)
  })

  test("does not launch Codex when the gateway is unavailable", () => {
    const f = fixture()
    f.run()
    const launcher = launcherFixture(f)
    const result = launcher.run([], { SETUP_CURL_EXIT: "7" })
    expect(result.exit).not.toBe(0)
    expect(result.output).toContain("Copilot API is unavailable")
    expect(result.output).not.toContain("fixture-gateway-key")
    expect(fs.existsSync(launcher.capture)).toBe(false)
  })

  test.each(["missing", "empty", "whitespace"])(
    "does not launch Codex when the gateway key becomes %s",
    (kind) => {
      const f = fixture()
      f.run()
      if (kind === "missing") fs.unlinkSync(f.keyPath)
      else fs.writeFileSync(f.keyPath, kind === "whitespace" ? " \t\n" : "\n")
      const launcher = launcherFixture(f)
      const result = launcher.run()
      expect(result.exit).not.toBe(0)
      expect(fs.existsSync(launcher.capture)).toBe(false)
      expect(result.output).not.toContain("fixture-gateway-key")
    },
  )
})
