# Rendered File Viewer Reliability Design

## Goal

Markdown and HTML files must reliably reach the Rendered state. Rendering requests must not invalidate each other, and a failed webview must recover automatically before the user sees an error.

## Architecture

`ParadisRenderedFileEditor` will use a single serialized render coordinator. File changes that arrive while rendering is in progress are coalesced into one follow-up render instead of starting competing work. Input replacement cancels the obsolete render, but a refresh for the same input never cancels a valid in-flight result.

The webview layer will expose the existing inner-frame load signal as `IWebview.onDidLoad`. The browser preload will emit this signal only after the pending content frame becomes the visible active frame. A render is successful only after its HTML has been sent and this signal has arrived.

The editor will retain the underlying webview while hidden. A fatal error or load timeout will dispose the failed overlay, create a new overlay, and replay the already generated HTML. After three presentation attempts, the normal workbench DOM—not the failed webview—will show an error and a Reload button. Reload performs a full render and webview recreation.

## State and Data Flow

1. `setInput` installs an input-scoped cancellation token and requests a render.
2. The coordinator reads the latest text and generates HTML once.
3. The editor claims and anchors the overlay webview.
4. The editor subscribes to `onDidLoad`, calls `setHtml`, and waits for the matching load completion.
5. On success, the loading/error overlay is hidden.
6. On timeout or fatal error, the overlay is recreated and the same HTML is presented again.
7. After the retry limit, the workbench-side error UI remains available even if the webview is unusable.

## Correctness Rules

- Only one render operation may execute at a time per editor pane.
- Refresh requests for the same input may be coalesced but must not cancel the running operation.
- Input replacement and `clearInput` must cancel obsolete work.
- Old content must be covered by the workbench loading layer while a different resource is being prepared.
- A load event from an obsolete webview or obsolete presentation attempt must not complete the current attempt.
- Automatic recovery must be bounded to three presentation attempts.
- Markdown remains script-disabled; readiness must not depend on injected document scripts.

## Error Handling

The error UI reports that the preview could not be loaded and offers Reload. Reload clears the error, recreates the webview, and starts a new serialized render. While a refresh is running, the workbench-side loading layer covers obsolete content; an exhausted refresh leaves the workbench-side error action available instead of a blank webview.

## Verification

Unit tests cover serialized execution, request coalescing, failure recovery, and retry exhaustion. Type checking covers the webview event propagation changes. The focused browser tests and existing Markdown front matter tests must pass before commit.
