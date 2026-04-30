/# with-opencode static Webview export evaluation

Date: 2026-04-24

## Goal

Evaluate whether `assistant-ui/examples/with-opencode` can be reused for Phase 4B as bundled static assets inside the `costrict` VSCode extension, instead of keeping the Phase 4A iframe pointed at a local Next.js dev/server.

## Result

The current Next.js app **can be statically exported** with `output: "export"`.

Temporary config used for the evaluation:

```ts
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
	output: "export",
	images: {
		unoptimized: true,
	},
}

export default nextConfig
```

Command:

```bash
cd /home/mini/workspace/costrict-space/assistant-ui/examples/with-opencode
pnpm build
```

Observed result:

```text
✓ Compiled successfully
✓ Generating static pages
Route (app)
┌ ○ /
└ ○ /_not-found
```

Generated directory:

```text
examples/with-opencode/out
```

Observed size:

```text
14M out
```

Representative files:

```text
out/index.html
out/404.html
out/_not-found.html
out/_next/...
```

## Implications

Because static export works, Phase 4B does **not** need to immediately create a separate Vite Webview subproject. The preferred next step is:

1. Add a dedicated static export script/config to `with-opencode`.
2. Copy or package `examples/with-opencode/out` into `costrict` extension assets.
3. Update `AssistantUIPanel` to support loading local static assets with `webview.asWebviewUri`.
4. Keep the existing Phase 4A `webUrl` iframe path as a development fallback.

## Remaining concerns

### Asset URL rewriting

The exported Next.js HTML references `_next` assets. When loaded from a VSCode Webview, these references must be converted to Webview URIs or served from a local file root with `localResourceRoots`.

Potential approaches:

- Post-process `index.html` and replace asset URLs with `webview.asWebviewUri(...)` values.
- Generate the static export with a stable relative asset prefix if supported by Next.js.
- Use the exported `out` directory as a resource root and inject a `<base>` tag or rewrite paths.

### CSP tightening

Phase 4A currently uses a loose local-development CSP to support a local iframe and Next dev HMR. Phase 4B should remove local Next dev allowances and tighten CSP to local Webview resources plus cs-cloud API endpoints.

### Runtime baseUrl injection

The static export path should prefer direct parent-page injection:

```html
<script nonce="...">
	window.__CS_CLOUD_BASE_URL__ = "http://127.0.0.1:45489/api/v1"
</script>
```

The `csCloudBaseUrl` query parameter can remain as a fallback for compatibility.

### Next.js dev artifacts

The Phase 4A HMR WebSocket error should disappear once local Next dev/server is removed from the Webview path.

### Build environment

The current environment uses Node v22.18.0 while the assistant-ui monorepo declares `node >=24`. Static export still succeeded, but CI/release should use Node 24+.

## Recommendation

Proceed with a Next static export based Phase 4B implementation before considering a Vite migration. Create a Vite Webview subproject only if asset rewriting or CSP constraints make the Next static export too costly.
