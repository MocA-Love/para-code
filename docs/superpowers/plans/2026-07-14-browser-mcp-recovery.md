# Browser MCP Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Para Browser MCPを、スクリーンショット失敗、CDP切断、tool timeout、BrowserView破棄からアプリ再起動なしでペイン単位に回復させる。

**Architecture:** bindingへ単調増加generationを付け、tokenごとのchrome-devtools-mcp子プロセスをgenerationとendpointに固定する。上流CDPはキャッシュ無効化付き1回再試行、BrowserView captureはpaint待機と透明判定付き最大5回再試行、BrowserView消滅は自動unbindとして扱う。

**Tech Stack:** TypeScript、Node.js HTTP/child_process、Electron BrowserView/NativeImage、VS Code IPC/Disposable、Mocha

## Global Constraints

- 設計書: `docs/superpowers/specs/2026-07-14-browser-mcp-recovery-design.md`
- あるtokenの障害で他tokenのbinding、CDP接続、子プロセスを破棄しない。
- tokenをログへ平文で出さず、SHA-256先頭12桁だけを使う。
- PNG/JPEGのviewport、full-page、document clipを共通のcapture境界へ通す。
- WebPは表示中の安全な生CDP経路だけを維持し、非表示では明示エラーにする。
- stale generationの結果をクライアントへ返さない。
- TDDで各テストのREDを確認してからproduction codeを書く。
- 各Task後に主担当の自己レビューと独立read-onlyレビューを行う。
- ユーザーの明示指示があるまでcommitとpushを行わない。
- `.serena/`と`app/design/mobile-relay-v3-recovery-design.md`へ触れない。

---

### Task 1: 上流CDPポートの自己回復

**Files:**
- Create: `src/vs/paradis/contrib/agentBrowser/test/node/paradisCdpUpstream.test.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisCdpUpstream.ts`

**Interfaces:**
- Produces: `IParadisCdpUpstreamOptions`
- Preserves: `resolvePort(timeoutMs?: number): Promise<number | undefined>`
- Changes: `fetchJson(path: string): Promise<unknown>`は1試行5秒、失敗時にport cacheを破棄して1回だけ再試行する。

- [x] **Step 1: stale port再解決と再試行上限の失敗テストを書く**

`IParadisCdpUpstreamOptions`へ`readFile`、`fetch`、`fetchTimeoutMs`を注入できる前提で、次の契約を追加する。

```ts
test('invalidates a stale cached port and retries once', async () => {
	const reads = ['41001\n', '41002\n'];
	const urls: string[] = [];
	const upstream = new ParadisCdpUpstream('/tmp/profile', new NullLogService(), {
		readFile: async () => reads.shift()!,
		fetch: async (url: string) => {
			urls.push(url);
			if (url.includes(':41001/')) { throw new Error('ECONNREFUSED'); }
			return { ok: true, status: 200, json: async () => ({ Browser: 'ok' }) };
		},
		fetchTimeoutMs: 5_000,
	});
	assert.deepStrictEqual(await upstream.fetchJson('/json/version'), { Browser: 'ok' });
	assert.deepStrictEqual(urls, [
		'http://127.0.0.1:41001/json/version',
		'http://127.0.0.1:41002/json/version',
	]);
});

test('does not retry more than once', async () => {
	let attempts = 0;
	const upstream = new ParadisCdpUpstream('/tmp/profile', new NullLogService(), {
		readFile: async () => `${41001 + attempts}\n`,
		fetch: async () => { attempts++; throw new Error('offline'); },
		fetchTimeoutMs: 5_000,
	});
	await assert.rejects(() => upstream.fetchJson('/json/list'), /offline/);
	assert.strictEqual(attempts, 2);
});
```

- [x] **Step 2: REDを確認する**

Run: `npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/node/paradisCdpUpstream.test.ts`

Expected: options引数とretryが未実装のためFAIL。

- [x] **Step 3: 注入可能な依存と1回retryを実装する**

実装する型と制御フロー:

```ts
export interface IParadisCdpUpstreamOptions {
	readonly readFile?: typeof fs.readFile;
	readonly fetch?: (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
	readonly fetchTimeoutMs?: number;
}

async fetchJson(path: string): Promise<unknown> {
	let firstError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const port = await this.resolvePort();
			if (!port) { throw new Error('Upstream Chromium CDP port not available'); }
			const res = await this.fetchImpl(`http://127.0.0.1:${port}${path}`, {
				signal: AbortSignal.timeout(this.fetchTimeoutMs),
			});
			if (!res.ok) { throw new Error(`Upstream CDP returned ${res.status} for ${path}`); }
			return res.json();
		} catch (error) {
			firstError ??= error;
			this._cachedPort = undefined;
			if (attempt === 1) { throw new Error(`Upstream CDP fetch failed after port refresh for ${path}`, { cause: error }); }
		}
	}
	throw firstError;
}
```

- [x] **Step 4: GREENと回帰を確認する**

Run: `npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/node/paradisCdpUpstream.test.ts`

Expected: 全テストPASS。

- [x] **Step 5: 自己レビューと独立レビュー**

キャッシュ無効化が該当upstreamだけに閉じること、retryが2回を超えないこと、AbortSignal timeoutがtimer leakを作らないことを確認する。

### Task 2: generation付きDevTools子プロセス

**Files:**
- Create: `src/vs/paradis/contrib/agentBrowser/test/node/paradisDevtoolsMcpProxy.test.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisDevtoolsMcpProxy.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisAgentBrowserService.ts`

**Interfaces:**
- Add: `IParadisDevtoolsMcpProxyOptions { spawnChild?, handshakeTimeoutMs?, callTimeoutMs? }`
- Change: `listTools(token, generation, wsEndpoint)`
- Change: `isProxiedTool(token, generation, wsEndpoint, name)`
- Change: `tryCallTool(token, generation, wsEndpoint, name, args, signal?)`
- Add to child entry: `generation: number`, `wsEndpoint: string`, `tokenFingerprint: string`

- [x] **Step 1: generation変更、timeout、abortの失敗テストを書く**

`PassThrough`と`EventEmitter`でfake childを作り、initialize/tools/listには応答し、tools/callを停止できるfixtureを用意する。次を検証する。

```ts
test('replaces a child when generation changes', async () => {
	const fixture = createFakeDevtoolsChildren();
	const proxy = new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { spawnChild: fixture.spawn });
	await proxy.listTools('secret-token', 1, 'ws://one');
	await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {});
	await proxy.tryCallTool('secret-token', 2, 'ws://two', 'take_snapshot', {});
	assert.strictEqual(fixture.children.length, 2);
	assert.strictEqual(fixture.children[0].killCount, 1);
});

test('kills a timed out child and respawns on the next call', async () => {
	const fixture = createFakeDevtoolsChildren({ hangToolCalls: 1 });
	const proxy = new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), {
		spawnChild: fixture.spawn,
		callTimeoutMs: 10,
	});
	const first = await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {});
	assert.strictEqual((first as { isError?: boolean }).isError, true);
	await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {});
	assert.strictEqual(fixture.children.length, 2);
});

test('kills a child when its client aborts', async () => {
	const controller = new AbortController();
	const fixture = createFakeDevtoolsChildren({ hangToolCalls: 1 });
	const proxy = new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { spawnChild: fixture.spawn });
	const call = proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {}, controller.signal);
	controller.abort();
	assert.strictEqual((await call as { isError?: boolean }).isError, true);
	assert.strictEqual(fixture.children[0].killCount, 1);
});
```

- [x] **Step 2: REDを確認する**

Run: `npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/node/paradisDevtoolsMcpProxy.test.ts`

Expected: generation/options/AbortSignal APIが未実装のためFAIL。

- [x] **Step 3: child identityと不健全時retireを実装する**

`_ensureChild`は次の条件を全て満たす場合だけ再利用する。

```ts
const reusable = existing
	&& !existing.killed
	&& existing.generation === generation
	&& existing.wsEndpoint === wsEndpoint;
if (existing && !reusable) {
	this._killChild(token, existing, 'binding generation changed');
}
```

`_request`はtimeoutまたはabort時に`_killChild(token, entry, reason)`を呼び、pending全件をrejectする。abort listenerは成功・失敗・cleanupの全経路でremoveする。ログでは`createHash('sha256').update(token).digest('hex').slice(0, 12)`だけを出す。

- [x] **Step 4: serviceへbinding generationを統合する**

`IBindingEntry`へ`generation`を追加し、serviceへ次を追加する。

```ts
private readonly _bindingGenerations = new Map<string, number>();
private _nextBindingGeneration = 0;

private _advanceBindingGeneration(token: string): number {
	const generation = ++this._nextBindingGeneration;
	this._bindingGenerations.set(token, generation);
	this._cdpGateway.closeConnectionsForToken(token);
	this._devtoolsProxy.retire(token);
	return generation;
}
```

bind/unbind/retireで世代を進める。`_callDevtoolsTool`は開始時のbinding参照とgenerationを保持し、await後に`this._bindings.get(token) === binding`を再確認する。不一致なら`PARA_BROWSER_RETRYABLE: binding changed while the tool was running`を`isError: true`で返す。

- [x] **Step 5: request abortをserviceからproxyへ渡す**

`_handleRequest`で`AbortController`を作り、`req.once('aborted')`と未完了の`res.once('close')`からabortする。`_dispatch`、`_callTool`、`_callDevtoolsTool`へsignalを渡し、finallyでlistenerを外す。

- [x] **Step 6: GREENと既存Agent Browserテストを確認する**

Run: `npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/node/paradisDevtoolsMcpProxy.test.ts`

Run: `npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/node/paradisAgentBrowserStatus.test.ts`

Expected: 全テストPASS。

- [x] **Step 7: 自己レビューと独立レビュー**

timeout/abortの二重settle、child exitとの競合、stale response、token平文ログ、他token破棄、tools cacheとgenerationの関係を確認する。

### Task 3: BrowserView破棄時の自動unbind

**Files:**
- Create: `src/vs/paradis/contrib/agentBrowser/common/paradisBrowserBindingLifecycle.ts`
- Create: `src/vs/paradis/contrib/agentBrowser/test/node/paradisBrowserBindingLifecycle.test.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/common/paradisAgentBrowser.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/electron-browser/paradisAgentBrowserBindingModel.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisAgentBrowserChannel.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisAgentBrowserService.ts`

**Interfaces:**
- Add: `paradisBindingsForMissingPages(bindings, livePageIds): IParadisPaneBinding[]`
- Add: `generation` to `IParadisPaneBinding`
- Add: `unbindIfCurrent(token, expectedGeneration): Promise<boolean>`
- Binding model consumes: `IBrowserViewWorkbenchService.onDidChangeBrowserViews`

- [x] **Step 1: missing page抽出の失敗テストを書く**

```ts
test('returns only bindings whose BrowserView disappeared', () => {
	const bindings = [binding('a', 'page-1'), binding('b', 'page-2')];
	assert.deepStrictEqual(
		paradisBindingsForMissingPages(bindings, new Set(['page-2'])).map(item => item.token),
		['a'],
	);
});
```

- [x] **Step 2: REDを確認する**

Run: `npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/node/paradisBrowserBindingLifecycle.test.ts`

Expected: helper未実装によりFAIL。

- [x] **Step 3: pure helperとbinding reconciliationを実装する**

Binding modelへ`IBrowserViewWorkbenchService`を注入し、`onDidChangeBrowserViews`を100ms schedulerへ集約する。known台帳で実際に`present -> absent`を観測したpageIdと観測時刻だけをpendingとして保持し、復元途中で未追加の無関係なbindingを掃除しない。最初に成功した`listBindings`で、`boundAt < observedAt`を満たす`{ token, pageId, generation }`だけを固定候補にする。同一ミリ秒は新bindingの誤解除を避けるため候補から除外する。取得失敗中または消滅検出後に成立したrebindを後続取得で候補へ昇格させない。固定候補ごとにshared processの`unbindIfCurrent(token, generation)`を呼び、現在generationが一致する場合だけ同期的にunbindする。`false`はstale確認としてその候補を完了し、例外だけ同じgenerationで低頻度再試行する。post-fetchでも元generationの消滅だけを確認し、新generationは触らない。pageId再追加時は候補を取り消す。space切替でknown viewsに残るページはunbindしない。reconcileは多重起動させず、実行中の変更は次の1回へまとめ、完了境界のmicrotask requestも取りこぼさない。pending解消時は予約済みretryも取り消す。

- [x] **Step 4: GREENを確認する**

Run: `npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/node/paradisBrowserBindingLifecycle.test.ts`

Expected: 全テストPASS。

- [x] **Step 5: 自己レビューと独立レビュー**

BrowserView close、space切替、renderer dispose、複数tokenが同一pageを共有する場合、復元途中の無関係page、page再追加、binding取得/個別IPCの一時失敗と同一generation再試行、reconcile多重実行と完了境界、missing検出後またはbinding取得失敗中の同token rebindが候補へ昇格せず維持されることを確認する。

### Task 4: paint待機・透明判定付きスクリーンショット

**Files:**
- Create: `src/vs/platform/browserView/common/browserViewScreenshot.ts`
- Create: `src/vs/platform/browserView/test/common/browserViewScreenshot.test.ts`
- Create: `src/vs/paradis/contrib/agentBrowser/test/electron-main/paradisScreenshotValidation.test.ts`
- Create: `src/vs/paradis/contrib/agentBrowser/test/node/paradisCdpFilterProxy.test.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/common/paradisAgentBrowser.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisCdpFilterProxy.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisCdpGateway.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisAgentBrowserService.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/electron-main/paradisCdpTargetService.ts`
- Modify: `src/vs/platform/browserView/common/browserView.ts`
- Modify: `src/vs/platform/browserView/electron-main/browserView.ts`

**Interfaces:**
- Add: `browserViewBitmapHasVisibleAlpha(bitmap: Uint8Array): boolean`
- Add: `captureBrowserViewWithRetry<T>(capture, isValid, waitForNextPaint, maxAttempts = 5): Promise<T>`
- Export: `paradisMapCaptureScreenshotParams(params)`
- Extend: `IParadisCdpScreenshotOptions` and `IBrowserViewCaptureScreenshotOptions` with `captureBeyondViewport?: boolean`
- Add: `IParadisBoundContext.isBoundPageVisible(): Promise<boolean>`とelectron-mainの`isViewVisible(viewId)`
- Preserve: browser-level session frameとpage-level WebSocketの両方で同じparameter policyを使う

- [x] **Step 1: 透明判定とparameter routingの失敗テストを書く**

```ts
test('rejects empty and fully transparent BGRA/RGBA bitmaps', () => {
	assert.strictEqual(browserViewBitmapHasVisibleAlpha(new Uint8Array()), false);
	assert.strictEqual(browserViewBitmapHasVisibleAlpha(new Uint8Array([10, 20, 30, 0])), false);
	assert.strictEqual(browserViewBitmapHasVisibleAlpha(new Uint8Array([10, 20, 30, 255])), true);
});

test('routes element document clips through delegated capture', () => {
	assert.deepStrictEqual(paradisMapCaptureScreenshotParams({
		format: 'png',
		clip: { x: 10, y: 20, width: 30, height: 40, scale: 1 },
		captureBeyondViewport: true,
	}), {
		format: 'png',
		pageRect: { x: 10, y: 20, width: 30, height: 40 },
		captureBeyondViewport: true,
	});
});
```

- [x] **Step 2: REDを確認する**

Run: `npm run test-node -- --run src/vs/platform/browserView/test/common/browserViewScreenshot.test.ts`

Run: `npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/node/paradisCdpFilterProxy.test.ts`

Expected: helper/export/new optionが未実装のためFAIL。

- [x] **Step 3: BrowserView captureを共通retry境界へ整理する**

`captureScreenshot`は非表示時のvisibility kick後、初回capture前に`_waitForNextPaint()`を呼ぶ。以後は最大5回、`UnknownVizError`、`image.isEmpty()`、`!browserViewBitmapHasVisibleAlpha(image.toBitmap())`をretry対象にし、再試行前にも次paintを待つ。それ以外の例外は直ちにthrowする。retry制御は`captureBrowserViewWithRetry`へ集約してnode testで回数、wait順序、上限、非retry例外を固定する。

`pageRect + captureBeyondViewport`は`BrowserViewDebugger.sendCommand('Page.captureScreenshot', { clip, captureBeyondViewport: true })`を使い、base64を`nativeImage.createFromBuffer`でdecodeして同じ検査へ通す。full-pageの既存CDP captureもdecode後に同じ検査へ通す。PNG/JPEG encodeは検査成功後だけ行う。Electron testでは`nativeImage.createFromBuffer`で透明PNG/不透明PNGを作り、実際の`toBitmap()` alpha位置も検証する。

- [x] **Step 4: filter proxyをsilent raw fallbackしない形へ変更する**

PNG/JPEGのviewport、full-page、scale 1のclipはdelegationする。delegationが`PARA_BROWSER_RETRYABLE`を返した場合は生CDPへfallbackせずtool errorを返す。`fromSurface: false`とscale != 1は対応外理由を明示する。WebPは`isBoundPageVisible()`がtrueの場合だけ既存raw経路へ流し、falseの場合はPNG/JPEGを案内するtool errorを返す。このpolicyはbrowser-level session frameとpage-level接続の両方へ適用する。delegated captureのundefined/null/例外は生CDPへfallbackせず`PARA_BROWSER_RETRYABLE`を返す。shared processはcapture/visibilityのawait前後でbinding参照とgenerationを比較し、rebind中の結果を捨てる。

- [x] **Step 5: GREENを確認する**

Run: `npm run test-node -- --run src/vs/platform/browserView/test/common/browserViewScreenshot.test.ts`

Run: `npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/node/paradisCdpFilterProxy.test.ts`

Run: `./scripts/test.sh --run src/vs/paradis/contrib/agentBrowser/test/electron-main/paradisScreenshotValidation.test.ts`

Expected: viewport/full-page/document clipのopaque結果、透明retry、retry上限がPASS。

- [x] **Step 6: 自己レビューと独立レビュー**

bitmap alpha offsetのElectron実機テスト、full-page pinch zoom復元、巨大画像上限、clip座標、hidden viewのvisibility状態、WebP互換性を確認する。

### Task 5: MCP shimのport/PID検証とtimeout

**Files:**
- Create: `src/vs/paradis/contrib/agentBrowser/node/paradisBrowserMcpShimCore.ts`
- Create: `src/vs/paradis/contrib/agentBrowser/test/node/paradisBrowserMcpShimCore.test.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisBrowserMcpShim.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/node/paradisAgentBrowserService.ts`

**Interfaces:**
- Add: `IParadisMcpPortFileRecord { protocolVersion, port, pid, instanceId, serviceStartedAt }`
- Add: `parseParadisMcpPortFile(raw): IParadisMcpPortFileRecord`
- Add: `isParadisMcpProcessAlive(pid, killFn?): boolean`
- Add: `writeParadisMcpPortFileAtomic(path, record)`
- Add: `probeParadisMcpInstance(record)`と同一socket検証付き`postParadisMcpRequest(...)`
- Add: `ParadisMcpPortFileReconciler`（1秒、single-flight）
- Add constants: connect timeout 5,000ms、overall timeout 310,000ms

- [x] **Step 1: port/PID validationの失敗テストを書く**

```ts
test('accepts only a live positive port and pid', () => {
	assert.deepStrictEqual(parseParadisMcpPortFile(JSON.stringify(record)), record);
	assert.throws(() => parseParadisMcpPortFile('{"port":0,"pid":123}'), /Invalid/);
	assert.throws(() => parseParadisMcpPortFile('{"port":47286,"pid":0}'), /Invalid/);
	assert.strictEqual(isParadisMcpProcessAlive(123, () => undefined), true);
	assert.strictEqual(isParadisMcpProcessAlive(123, () => { throw new Error('ESRCH'); }), false);
});
```

port fileの一時ファイル→rename順序、書込失敗時の一時ファイル清掃、旧shared processのdisposeが固定port fileを削除しないことも回帰テストまたは明示的な構造検査で固定する。

- [x] **Step 2: REDを確認する**

Run: `npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/node/paradisBrowserMcpShimCore.test.ts`

Expected: core module未実装によりFAIL。

- [x] **Step 3: core helperとHTTP timeoutを実装する**

shimはport fileを毎request読み、PIDが不在なら1回読み直す。認証情報なしのhealth GETでprotocolVersion、instanceId、serviceStartedAtを検証し、その応答に使われた同一TCP socketがPOSTへ割り当てられた場合だけBearer headerと本文を設定・送信する。`http.request`はsocket接続前5秒でdestroyし、healthを含む全体310秒timerでもdestroyする。response end/error/aborted/close、request error、timeout、遅着responseの全経路でtimer/listenerを解放し、二重settleしない。

shared processはport fileを同一ディレクトリの一時ファイルへ書いてからrenameし、disposeでは固定port fileをunlinkしない。1秒周期のsingle-flight reconcilerはrecord世代を開始時刻とinstanceIdで比較し、新しいownerのPIDとhealth identityが一致するときだけ退避する。旧publisherの遅延renameが新recordを上書きしても新ownerがboundedに再取得する。

- [x] **Step 4: GREENを確認する**

Run: `npm run test-node -- --run src/vs/paradis/contrib/agentBrowser/test/node/paradisBrowserMcpShimCore.test.ts`

Expected: 全テストPASS。

- [x] **Step 5: 自己レビューと独立レビュー**

長時間performance toolを300秒より前に切らないこと、stale/部分書込port file、旧shared process dispose、WindowsのPID probe、notification応答、stdin終了時inflight待機を確認する。

独立レビューで検出したtimeout後の遅着response、health timeout後の遅着response、`request.end()`同期例外後の遅延error、close-only response、旧/new publisher rename逆転、PID再利用・別loopback service、health後のsocket replacementをTDDで修正済み。最終レビューはCritical 0 / Important 0。古いrecord説明コメントのMinor 1件も5field構成へ更新した。

### Task 6: 第1単位の統合検証とレビュー

**Files:**
- Review: 本計画で変更した全ファイル
- Update: `docs/superpowers/plans/2026-07-14-browser-mcp-recovery.md`のcheckbox

**Interfaces:**
- Consumes: Tasks 1–5
- Produces: 第1単位の検証済みworking tree差分

- [x] **Step 1: 対象テストをまとめて実行する**

Run: `npm run test-node -- --runGlob 'vs/paradis/contrib/agentBrowser/test/node/*.test.js'`

Run: `./scripts/test.sh --run src/vs/paradis/contrib/agentBrowser/test/electron-main/paradisScreenshotValidation.test.ts`

Expected: exit code 0、unhandled rejectionなし。

- [x] **Step 2: 型検査・lint・レイヤー検査を実行する**

Run: `npm run compile`

Run: `npm run eslint -- src/vs/paradis/contrib/agentBrowser src/vs/platform/browserView`

Run: `npm run valid-layers-check`

Expected: exit code 0。

結果: `transpile-client`と対象TSの直接ESLintは成功。`npm run compile`と`valid-layers-check`は今回範囲外の`paradisMobileAgentChat.ts`既知TS2339 11件だけで停止し、Unit 1由来の型/layer errorは0件。

- [x] **Step 3: 主担当として全差分を自己レビューする**

Run: `git diff --check`

Run: `git diff --stat HEAD`

Run: `git diff HEAD -- src/vs/paradis/contrib/agentBrowser src/vs/platform/browserView docs/superpowers`

generation逆転、timeout/abort二重settle、child/zombie leak、BrowserView dispose競合、transparent false positive、WebP回帰、token漏えい、他token影響を行単位で確認する。

- [x] **Step 4: 独立read-only統合レビューを行う**

設計書と`git diff HEAD`を渡し、要件整合、並行性、resource cleanup、security、test coverageをレビューする。Critical/Importantは同じ単位で修正し、対象検証を再実行する。

- [x] **Step 5: commitせず次単位へ引き継ぐ**

ユーザーの明示指示がないためcommit/pushは行わない。変更ファイル、検証結果、レビュー指摘と対応を記録して第2単位へ進む。

統合結果: Agent Browser Node 136件、Node全体12,038件、BrowserView common 20件、Electron 2件成功。`git diff --check`成功。独立最終レビューApprove（Critical 0 / Important 0、コメントMinorは修正済み）。
