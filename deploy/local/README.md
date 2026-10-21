# Local Copilot API and Codex setup

This deployment connects Codex to a local Copilot API gateway while keeping
ChatGPT sign-in available for mobile Remote Control. The installer supports the
Windows Codex desktop app with a WSL backend, plus the Linux/WSL Codex CLI.

## One-command Codex setup

On the new device, clone this repository and install [Bun](https://bun.sh).
The gateway must already have its providers and API keys configured. Save a
matching gateway API key in `~/.local/share/copilot-api/gateway_key`, with its
directory mode `0700` and the key file mode `0600`. Keep the key outside Git.

From the repository root in WSL, run:

```sh
bun run setup:codex
```

The installer uses `CODEX_HOME` when set; otherwise it discovers the signed-in
Windows user's `.codex` directory. For a Linux/WSL CLI installation, run:

```sh
bun run setup:codex --cli
```

Useful options:

```sh
# Preview changes without writing files.
bun run setup:codex --dry-run

# Select a different desktop config directory explicitly.
bun run setup:codex --codex-home "/mnt/c/Users/Your Name/.codex"

# Use a different gateway data directory, address, or model.
bun run setup:codex --gateway-home "$HOME/.local/share/copilot-api" \
  --url http://127.0.0.1:4141 --model copilot-cli/gpt-6.1-sol
```

`--gateway-home` selects the directory containing `gateway_key`. Choose a model
that the target gateway exposes through `/models`. Run
`bun run setup:codex --help` for all options.

The installer:

- Updates the selected `config.toml` in place and names the provider **Copilot
  API**. It preserves unrelated settings and existing reasoning preferences.
- Enables ChatGPT authentication and sends the gateway key separately through
  `x-api-key`. It removes conflicting provider command/bearer authentication and
  the unsupported top-level `service_tier` setting.
- Installs `~/.config/copilot-api/codex-env.sh` and adds a guarded loader to the
  Bash login file used by the desktop WSL backend (`.bash_profile`, `.bash_login`,
  or `.profile`, in that order). The loader reads the key at launch and exports
  `COPILOT_API_GATEWAY_KEY` only for Codex Desktop.
- Installs the optional CLI launcher at `~/.local/bin/codex-copilot-api`. The
  launcher loads the same key, checks gateway health, and forwards arguments to
  `codex` on `PATH`, preserving an explicit `CODEX_HOME`. Run setup with `--cli`
  before using the launcher with its default Linux Codex home.
- Backs up changed existing files under the Linux home directory at
  `~/.local/state/copilot-api/codex-setup/<run>/`, with directory mode `0700`
  and file mode `0600`. Reruns
  with the same inputs leave files unchanged. Invalid or ambiguous TOML and
  missing/empty key files fail before configuration changes.

The installer does not sign in, start the gateway, or restart Codex. It stores
the key's path in the helper and reads the key at launch. Backups can contain
sensitive data already present in the original configuration. Setup targets
that are symbolic links are rejected before changes; use regular files.

## Complete mobile Remote Control setup

After installation:

1. Start the gateway and check its status using the commands below.
2. Fully quit and reopen the Windows Codex desktop app so its WSL backend loads
   the environment helper.
3. Sign in to ChatGPT in the desktop app and mobile app with the same account
   and workspace.
4. In desktop **Settings → Connections → Control this PC**, choose **Set up**
   (or **Add**) and scan the QR code with the mobile app.
5. Keep the desktop awake, online, and signed in.

ChatGPT sign-in authenticates the remote connection; the separate gateway key
authenticates model requests. The gateway prioritizes `x-api-key` over the
ChatGPT `Authorization` header. The phone connects through Codex's remote relay,
so the gateway can stay bound to `127.0.0.1`.

This authentication layout was checked with the Windows desktop WSL runtime
`0.163.0-alpha.11`: configuration loading succeeded and authenticated model
discovery returned HTTP 200. Mobile pairing still requires the interactive
sign-in and QR steps on each device. Native Windows and macOS desktop launch
environment setup is outside this installer's current scope.

See OpenAI's [remote connections guide](https://developers.openai.com/codex/remote-connections)
and [ChatGPT sign-in through a gateway guide](https://developers.openai.com/codex/enterprise/sign-in-with-chatgpt-through-a-gateway).

## Local gateway service

`prepare-gh-auth.mjs` reuses an existing GitHub CLI login through `gh auth token`.
It configures an `openai-responses` provider named `copilot-cli` using the
account's GitHub Copilot endpoint directly, and disables the built-in Copilot
provider for this deployment. The older SDK bridge is independent.

The sample systemd user service expects this checkout at `~/code/copilot-api`,
Node.js and `gh` on its PATH, an existing `gh` login, a built `dist/main.js`, and
gateway API keys already configured. Adjust the service paths if the checkout
is elsewhere. See the [gateway CLI guide](../../docs/guides/en/cli.md) for provider
and API key configuration.

After building and configuring the gateway:

```sh
install -d -m 0700 ~/.config/systemd/user
install -m 0644 deploy/local/copilot-api.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now copilot-api.service
```

Check or follow the service:

```sh
systemctl --user status copilot-api.service --no-pager
journalctl --user -u copilot-api.service -f
curl --noproxy '*' --fail http://127.0.0.1:4141/
```

The health endpoint returns `Server running`; model requests also require a
valid key and an available provider. Restart the service after changing the
`gh` login. The startup hook validates account/model access and atomically
updates credentials and model metadata in `COPILOT_API_HOME/config.json`
(default `~/.local/share/copilot-api/config.json`). It fails explicitly when
authentication, model discovery, or writing fails, and never prints tokens.

`copilot-api-community.config.toml` is a reference configuration for manual
setup. Merge it into the active `config.toml` and install the environment helper
using the installer; Codex does not automatically load a separate file by this
name. Keep `config.json`, `github_token`, `gateway_key`, and session state outside
Git. Generic catalog context and effort choices may use static metadata rather
than the account's actual limits.
