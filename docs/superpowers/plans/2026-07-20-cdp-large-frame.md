# Para Browser CDP Large-Frame Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow every valid Para Browser CDP frame up to 32 MiB so large debugger metadata does not disconnect chrome-devtools-mcp.

**Architecture:** Keep the existing proxy, routing, and fail-closed behavior. Replace the 1 MiB ordinary frame ceiling with the existing 32 MiB transport ceiling and reuse that value for screenshot frames, the connecting queue, and open-socket backpressure so no internal boundary rejects a single otherwise-valid 32 MiB frame.

**Tech Stack:** TypeScript, Node.js WebSocket (`ws`), Mocha TDD tests, VS Code gulp build.

## Global Constraints

- Browser-level and page-level CDP traffic accepts valid frames up to 32 MiB.
- Frames above 32 MiB still fail closed.
- The endpoint remains loopback-only and pane-scoped.
- Request-count, routing-entry, identifier-length, pending-policy-byte, and connection-capacity limits remain unchanged.
- Existing unrelated worktree changes must not be staged or committed.

---

### Task 1: Expand and verify the shared CDP frame boundary

**Files:**
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisCdpFilterProxy.ts:103-118`
- Test: `src/vs/paradis/contrib/agentBrowser/test/node/paradisCdpFilterProxy.test.ts:796-880`

**Interfaces:**
- Consumes: `paradisProxyBrowserUpgrade`, `paradisProxyPageUpgrade`, `createOpenBrowserProxyFixture`, and `publishAllowedSession` from the existing proxy test fixture.
- Produces: A single 32 MiB ordinary CDP frame boundary used by parsing, forwarding, pre-open queuing, screenshot payloads, and open-socket backpressure.

- [x] **Step 1: Update the boundary tests before production code**

Add a browser-proxy regression test that publishes an allowed session and sends a valid 2 MiB `Debugger.scriptParsed` event:

```typescript
test('forwards valid ordinary upstream frames larger than 1 MiB', async () => {
	const fixture = await createOpenBrowserProxyFixture();
	publishAllowedSession(fixture, 'session-1');
	fixture.client.sent.length = 0;
	fixture.client.sentOptions.length = 0;
	const sourceMapUrl = `data:application/json;base64,${'x'.repeat(2 * 1024 * 1024)}`;

	fixture.upstream.emit('message', Buffer.from(JSON.stringify({
		sessionId: 'session-1',
		method: 'Debugger.scriptParsed',
		params: { scriptId: '1', url: 'https://example.test/app.js', sourceMapURL: sourceMapUrl },
	})));

	assert.strictEqual(fixture.client.closeCalls, 0);
	const forwarded = parseSent(fixture.client)[0] as { params?: { sourceMapURL?: string } };
	assert.strictEqual(forwarded.params?.sourceMapURL, sourceMapUrl);
});
```

Update the existing boundary fixtures from 1 MiB or 4 MiB to 32 MiB:

```typescript
Buffer.alloc(32 * 1024 * 1024 + 1, 0x20)
```

Use `32 * 1024 * 1024` for blocked `bufferedAmount` values. Increase the connecting-queue payload to 8 MiB and send five frames so the aggregate exceeds 32 MiB while remaining below the request-count limit.

- [x] **Step 2: Compile the test and verify the regression test fails for the expected reason**

Run:

```bash
npm run typecheck-client
npm run compile-client
./scripts/test.sh --run src/vs/paradis/contrib/agentBrowser/test/node/paradisCdpFilterProxy.test.ts --grep "forwards valid ordinary upstream frames larger than 1 MiB"
```

Expected: TypeScript compilation succeeds; the focused test fails because `fixture.client.closeCalls` is non-zero under the old 1 MiB limit.

- [x] **Step 3: Implement one shared 32 MiB transport boundary**

Replace the four transport-size constants with:

```typescript
const MAX_CDP_PENDING_REQUESTS = 1_024;
const MAX_CDP_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_CDP_SCREENSHOT_FRAME_BYTES = MAX_CDP_FRAME_BYTES;
const MAX_CDP_CONNECTING_QUEUE_BYTES = MAX_CDP_FRAME_BYTES;
const MAX_CDP_OPEN_BUFFERED_BYTES = MAX_CDP_FRAME_BYTES;
```

Update the adjacent comment to explain that large inline source maps can make one `Debugger.scriptParsed` frame exceed 1 MiB and that all four limits intentionally share the same bounded ceiling.

- [x] **Step 4: Type-check, compile, and run the focused proxy suite**

Run:

```bash
npm run typecheck-client
npm run compile-client
./scripts/test.sh --run src/vs/paradis/contrib/agentBrowser/test/node/paradisCdpFilterProxy.test.ts
```

Expected: Each command exits 0 and the proxy suite reports zero failures.

- [x] **Step 5: Perform static self-review and repository checks**

Run:

```bash
git diff --check
npm run valid-layers-check
git diff -- src/vs/paradis/contrib/agentBrowser/node/paradisCdpFilterProxy.ts src/vs/paradis/contrib/agentBrowser/test/node/paradisCdpFilterProxy.test.ts
git status --short
```

Verify that only the intended source and test files are staged later, no credentials or user data appear, no `console.log`/`TODO`/`FIXME` was added, and frames above 32 MiB still close the transport.

- [x] **Step 6: Commit and push only the implementation files and this plan**

Run:

```bash
git add -- docs/superpowers/plans/2026-07-20-cdp-large-frame.md src/vs/paradis/contrib/agentBrowser/node/paradisCdpFilterProxy.ts src/vs/paradis/contrib/agentBrowser/test/node/paradisCdpFilterProxy.test.ts
git diff --cached --check
git diff --cached --name-status
git commit -m "fix: allow large Para Browser CDP frames"
git push origin main
```

Expected: The commit contains exactly the plan, proxy source, and proxy test files; the push updates `origin/main` without staging unrelated worktree changes.
