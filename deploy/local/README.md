# Local Copilot CLI authentication deployment

These files capture the local Linux/WSL deployment under `~/code/copilot-api`.
The existing Copilot SDK login uses `gh-cli`; the gateway reuses that login
through `gh auth token` without a new device authorization.

`prepare-gh-auth.mjs` configures the supported `openai-responses` provider named
`copilot-cli`, using the account's GitHub Copilot API endpoint directly. It
disables the builtin Copilot provider because its token exchange rejects the
existing GitHub CLI credential. The older SDK bridge is independent.

## Files and installation

- `prepare-gh-auth.mjs`: service startup hook; reads `COPILOT_API_HOME/config.json`
  (default `~/.local/share/copilot-api/config.json`), validates account/model
  access, and atomically updates the provider credential and model metadata.
- `copilot-api.service`: systemd user service on `127.0.0.1:4141`; runs the hook
  from this checkout on each start. Requires Node.js, `gh` on the service PATH,
  an existing `gh` login, and a built `dist/main.js`.
- `copilot-api-community.config.toml`: Codex 0.163.0 profile. Adjust its absolute
  gateway key path for another account. It contains no key or token.
- `codex-copilot-api`: optional launcher selecting the Linux Codex home/profile.

The service expects an existing gateway config with API keys already configured.
Keep its directory mode `0700` and its credential/key files mode `0600`. Neither
`config.json`, `github_token`, `gateway_key`, nor session state belongs in Git.
The hook fails explicitly if authentication, model discovery, or writing fails.

From the repository root, after building and configuring gateway API keys:

```sh
install -m 0644 deploy/local/copilot-api.service ~/.config/systemd/user/
install -m 0600 deploy/local/copilot-api-community.config.toml ~/.codex/
install -m 0755 deploy/local/codex-copilot-api ~/.local/bin/
systemctl --user daemon-reload
systemctl --user enable --now copilot-api.service
codex-copilot-api
```

Restart the service after changing the `gh` login. The hook never prints tokens
or sends them to a host outside the allowlisted GitHub Copilot endpoints.

The saved Linux and desktop/WSL default configs also select
`copilot-api-community` and `copilot-cli/gpt-6.1-sol`; their other user settings
are deliberately kept outside this repository. To apply the default elsewhere,
merge the profile's model/provider/features entries into the existing config.
Preserve the preferred reasoning effort and remove any inherited `service_tier`
setting: Copilot rejects Fast service tiers. The gateway normalizes unsupported
reasoning efforts using the account's discovered capabilities.

The previous deployment completed text requests and a shell tool round trip
through the new gateway, including requests with both default Codex configs.
Unauthenticated model discovery returned HTTP 401. Generic catalog context and
effort choices may use static metadata rather than the account's actual limits.
