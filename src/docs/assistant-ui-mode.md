# Assistant UI / cs-cloud mode

This document describes the experimental Assistant UI mode added alongside the existing CoStrict VSCode Webview mode.

## Status

The integration is currently a Phase 4A demo:

- The VSCode extension opens a dedicated `WebviewPanel` with command `costrict.openAssistantUI`.
- The Webview loads the local `with-opencode` Next.js dev/server in an iframe.
- The iframe receives the cs-cloud OpenCode-compatible API URL through `csCloudBaseUrl`.
- A visible diagnostics strip is rendered above the iframe while this mode is experimental.

Phase 4B will replace the local Next.js iframe with bundled static Webview assets.

## Entry point

Command Palette command:

```text
CoStrict: Open Assistant UI
```

Command id:

```text
costrict.openAssistantUI
```

This command is intentionally separate from the existing CoStrict Webview/provider entry points. It opens an editor-area WebviewPanel named `CoStrict Assistant UI` and can coexist with the original CoStrict side panel.

## Configuration

All settings use the dedicated `costrict.assistantUI.*` namespace.

| Setting                                 | Default                 | Description                                                                                                                                       |
| --------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `costrict.assistantUI.enabled`          | `true`                  | Enables or disables the experimental Assistant UI command.                                                                                        |
| `costrict.assistantUI.csCloudPath`      | `cs-cloud`              | Command or absolute path used to start cs-cloud.                                                                                                  |
| `costrict.assistantUI.port`             | `45489`                 | Local port used when starting cs-cloud automatically.                                                                                             |
| `costrict.assistantUI.autoStartCsCloud` | `true`                  | Starts cs-cloud on demand if the health endpoint is not ready.                                                                                    |
| `costrict.assistantUI.baseUrl`          | `""`                    | Explicit OpenCode-compatible cs-cloud API base URL, for example `http://127.0.0.1:45489/api/v1`. When set, the extension does not start cs-cloud. |
| `costrict.assistantUI.webUrl`           | `http://127.0.0.1:3000` | Temporary `with-opencode` web app URL used by the Phase 4A iframe demo.                                                                           |

## Local demo workflow

Start a current cs-cloud daemon from source:

```bash
cd /home/mini/workspace/costrict-space/cs-cloud
pkill -f cs-cloud || true
go run ./cmd/cs-cloud start --port 45489
```

Verify the compatibility endpoints:

```bash
curl -i http://127.0.0.1:45489/api/v1/runtime/health
curl -i 'http://127.0.0.1:45489/api/v1/experimental/session?roots=true&archived=true'
```

Both should return HTTP 200. If the second endpoint returns 404, the daemon is old and does not include the OpenCode-compatible routes.

Start the iframe web app:

```bash
cd /home/mini/workspace/costrict-space/assistant-ui/examples/with-opencode
pnpm dev
```

Open the command palette and execute:

```text
CoStrict: Open Assistant UI
```

## Runtime URL injection

The parent Webview constructs the iframe URL by appending:

```text
csCloudBaseUrl=http%3A%2F%2F127.0.0.1%3A45489%2Fapi%2Fv1
assistantUIDebug=1
```

The `with-opencode` app resolves its runtime base URL in this order:

1. `window.__CS_CLOUD_BASE_URL__`
2. `csCloudBaseUrl` query parameter
3. `NEXT_PUBLIC_OPENCODE_BASE_URL`
4. `http://localhost:4096`

Because Phase 4A loads `with-opencode` in an iframe, the query parameter is the active path. Parent-page `window.__CS_CLOUD_BASE_URL__` is kept for Phase 4B static Webview embedding.

## Diagnostics

The parent Webview renders a diagnostics strip above the iframe. It shows:

```text
baseUrl: http://127.0.0.1:45489/api/v1
iframe: http://127.0.0.1:3000/?csCloudBaseUrl=...&assistantUIDebug=1
health: 200 OK
sessions: 200 OK
```

Interpretation:

- `health: 200 OK` means the parent Webview can reach cs-cloud.
- `sessions: 200 OK` means the daemon has the OpenCode-compatible `/experimental/session` route.
- `sessions: 404` means an old daemon/binary is running.
- `failed` usually means the daemon is not reachable, CORS failed, or the URL/port is wrong.

The iframe also shows a debug block when `assistantUIDebug=1` is present:

```text
assistantUIDebug=1
baseUrl: http://127.0.0.1:45489/api/v1
query: ?csCloudBaseUrl=...&assistantUIDebug=1
```

If the parent diagnostics are OK but the iframe debug baseUrl is wrong, the iframe URL injection is broken. If both are OK but no `api/v1` requests are emitted by the iframe, investigate `@assistant-ui/react-opencode` runtime initialization.

## Known limitations

- Next.js dev HMR may log WebSocket failures such as:

```text
ws://127.0.0.1:3000/_next/webpack-hmr
```

This affects hot reload only and should disappear after Phase 4B static Webview bundling.

- The current CSP is intentionally loose for local Phase 4A development:

```text
frame-src http://127.0.0.1:* http://localhost:*
connect-src http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*
```

It must be tightened when static assets are bundled.

- The current daemon strategy uses a fixed/configured port and PATH/configured `cs-cloud` binary. Packaging, binary download, random port selection, and upgrade handling are future work.

## Separation from the existing CoStrict mode

Assistant UI mode uses:

- Separate command id: `costrict.openAssistantUI`
- Separate config namespace: `costrict.assistantUI.*`
- Separate module directory: `src/assistant-ui/extension`
- Separate WebviewPanel type: `costrictAssistantUI`
- Separate panel lifecycle and diagnostics

It does not reuse the existing CoStrict Webview provider, task runtime, postMessage protocol, or storage keys.
