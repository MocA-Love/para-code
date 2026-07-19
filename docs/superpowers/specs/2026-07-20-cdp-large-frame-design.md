# Para Browser CDP large-frame design

## Problem

Para Browser's CDP proxy permits up to 32 MiB of buffered outbound data but rejects each ordinary CDP frame above 1 MiB. Heavy development pages can legitimately emit larger individual frames. The observed page emitted a 3,556,783-byte `Debugger.scriptParsed` event for an inline source map, causing the proxy to close the browser-level WebSocket and making `evaluate_script` and `take_snapshot` fail repeatedly with `Target closed`.

## Decision

Raise the per-frame limit for all ordinary CDP traffic from 1 MiB to 32 MiB. Keep the existing 32 MiB screenshot limit, open-socket buffered-byte limit, and upstream WebSocket `maxPayload` limit unchanged. One shared constant will describe the maximum accepted CDP frame size so parsing, forwarding, and backpressure checks do not diverge.

This intentionally supports large commands, responses, and events because Para Browser is a debugging transport and legitimate CDP payloads are not limited to a small fixed set of event methods. The endpoint remains loopback-only and pane-scoped, and aggregate buffering remains bounded at 32 MiB per connection.

## Behavior

- Browser-level and page-level CDP connections accept valid JSON CDP frames up to 32 MiB.
- Frames above 32 MiB still fail closed.
- Existing request-count, routing-entry, identifier-length, pending-policy-byte, and connection-capacity limits remain unchanged.
- CDP frames continue to be forwarded as text WebSocket frames.
- Screenshot handling keeps its existing bounded coordination and response validation.

## Regression coverage

Update the proxy tests to cover both boundaries:

- A valid ordinary upstream CDP event larger than 1 MiB is forwarded without closing the connection.
- An ordinary upstream frame larger than 32 MiB closes the connection.
- An oversized client command larger than 32 MiB is rejected before forwarding.
- Existing buffered-backpressure and screenshot tests continue to exercise their independent limits.

## Scope

Only the CDP frame-size policy and its focused regression tests change. No binding, authority, space-switching, screenshot, MCP, or browser lifecycle behavior is modified.
