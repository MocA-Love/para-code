/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵 chrome-devtools-mcp のツールの入口と出口を、Para Code 側で少しだけ変える（vendored は触らない）。
//   - wait_for: `text` を文字列でも受ける（配列へ包んで渡す）。成功時のスナップショットは `includeSnapshot`
//     を付けたときだけ返す（既定は返さない。応答の中央値が 5,889 字あり、毎回会話を圧迫していた）
//   - take_snapshot: 本文を {@link PARADIS_SNAPSHOT_MAX_CHARS} 字で切り、続きは `offset` で取らせる。
//     `root`（uid）を渡されたら、その要素の部分木だけを返す（取ったスナップショットから切り出す）
//   - click / fill などの「not interactive」に、直前にゲートウェイが入力を断った理由を書き足す
//   - Target closed で失敗した読み取り系のツールを 1 回だけ呼び直してよいかを決める
// 子プロセスの zod は未知の引数を断るので、Para Code 側で足した引数は渡す前に必ず取り除く。

/** take_snapshot が 1 回に返す本文の上限（文字数）。 */
export const PARADIS_SNAPSHOT_MAX_CHARS = 20_000;

const SNAPSHOT_HEADING = '## Latest page snapshot';

/**
 * Target closed（接続が切れた・セッションが外れた）で失敗したとき、呼び直しても結果が変わらない
 * ツール。入力・遷移・スクリプト実行は、失敗の前にページへ届いていたかもしれないので入れない。
 */
const RETRY_SAFE_TOOLS: ReadonlySet<string> = new Set([
	'take_snapshot',
	'take_screenshot',
	'wait_for',
	'list_pages',
	'list_console_messages',
	'get_console_message',
	'list_network_requests',
	'get_network_request',
	'emulate',
]);

/** 失敗が「要素が操作できるようにならなかった」としか言わない入力系のツール。 */
const INPUT_TOOLS: ReadonlySet<string> = new Set([
	'click', 'click_at', 'hover', 'fill', 'fill_form', 'type_text', 'press_key', 'drag', 'upload_file',
]);

type IJsonSchemaObject = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Para Code が足した・変えた引数を、子プロセスへ渡す前の形に戻したもの。 */
export interface IParadisPreparedDevtoolsCall {
	readonly args: unknown;
	/** wait_for で、スナップショットを返すか。 */
	readonly includeSnapshot?: boolean;
	/** take_snapshot で、本文のどこから返すか。 */
	readonly snapshotOffset?: number;
	/** take_snapshot で、この uid の要素の部分木だけを返す。 */
	readonly snapshotRoot?: string;
}

/** tools/list で公開するスキーマ。wait_for と take_snapshot の引数を足す・広げる（他はそのまま）。 */
export function paradisAdjustDevtoolsToolDescriptor<T extends { readonly name: string; readonly description?: string; readonly inputSchema?: unknown }>(tool: T): T {
	if (!isRecord(tool.inputSchema) || !isRecord(tool.inputSchema.properties)) {
		return tool;
	}
	const properties: IJsonSchemaObject = { ...tool.inputSchema.properties };
	let description = tool.description;
	if (tool.name === 'wait_for') {
		description = `${tool.description ?? 'Wait for the specified text to appear on the selected page.'} By default the response does not include a page snapshot; pass includeSnapshot: true or call take_snapshot when you need element uids.`;
		const text = isRecord(properties.text) ? properties.text : { type: 'array', items: { type: 'string' }, minItems: 1 };
		const arraySchema: IJsonSchemaObject = { ...text };
		delete arraySchema.description;
		properties.text = {
			anyOf: [{ type: 'string', minLength: 1 }, arraySchema],
			description: 'Text to wait for: one string, or a non-empty list of strings (resolves when any of them appears on the page).',
		};
		properties.includeSnapshot = {
			type: 'boolean',
			description: 'Whether to include a page snapshot in the response once the text appears. Default is false (call take_snapshot when you need one).',
		};
	} else if (tool.name === 'take_snapshot') {
		// Para Code だけが付ける内部の引数（vendored の PARA-PATCH）。エージェントには見せない
		delete properties.paraCodeRootRect;
		properties.offset = {
			type: 'integer',
			minimum: 0,
			description: `Character offset into the snapshot text. Snapshots longer than ${PARADIS_SNAPSHOT_MAX_CHARS} characters are returned in parts; the response says which offset to pass for the next part. Alternatively pass filePath to save the whole snapshot.`,
		};
		properties.root = {
			type: 'string',
			description: 'uid of an element from an earlier snapshot. Only that element and its descendants are returned (for example one dialog, form or table), which keeps the response short. The uids stay the same as in the full snapshot. Not combined with filePath.',
		};
	} else {
		return tool;
	}
	return { ...tool, ...(description !== undefined ? { description } : {}), inputSchema: { ...tool.inputSchema, properties } };
}

/** 子プロセスへ渡す引数に戻す（足した引数を取り除き、wait_for の文字列を配列へ包む）。 */
export function paradisPrepareDevtoolsToolCall(name: string, args: unknown, options?: { readonly measureRoot?: boolean }): IParadisPreparedDevtoolsCall {
	if (!isRecord(args)) {
		return { args };
	}
	if (name === 'wait_for') {
		const { includeSnapshot, ...rest } = args;
		const text = typeof rest.text === 'string' ? [rest.text] : rest.text;
		return { args: { ...rest, text }, includeSnapshot: includeSnapshot === true };
	}
	if (name === 'take_snapshot') {
		// `paraCodeRootRect` は Para Code だけが付ける（エージェントが渡しても捨てる）
		const { offset, root, ...rest } = args;
		delete rest.paraCodeRootRect;
		const snapshotOffset = typeof offset === 'number' && Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
		const snapshotRoot = typeof root === 'string' && root.length > 0 && rest.filePath === undefined ? root : undefined;
		// root の要素の位置は vendored の take_snapshot の中で測る（エージェントのカーソルの枠。q.html Q297 の 3）。
		// 別の evaluate_script で測るとタブの道具の順番を握り、次の道具を待たせるため。vendored が引数を知っている
		// （tools/list のスキーマにある）ときだけ付ける。PARA-PATCH を当て忘れた vendored は知らない引数を断るため
		return { args: snapshotRoot !== undefined && snapshotOffset === 0 && options?.measureRoot === true ? { ...rest, paraCodeRootRect: snapshotRoot } : rest, snapshotOffset, ...(snapshotRoot !== undefined ? { snapshotRoot } : {}) };
	}
	return { args };
}

/** Target closed で失敗した呼び出しを 1 回だけ呼び直してよいか。 */
export function paradisShouldRetryDevtoolsToolAfterTargetClosed(name: string, result: unknown): boolean {
	if (!RETRY_SAFE_TOOLS.has(name)) {
		return false;
	}
	const text = firstErrorText(result);
	return text !== undefined && /Target closed|Session closed|Connection closed|Session with given id not found/i.test(text);
}

function firstErrorText(result: unknown): string | undefined {
	if (!isRecord(result) || result.isError !== true || !Array.isArray(result.content)) {
		return undefined;
	}
	const part = result.content.find(item => isRecord(item) && item.type === 'text' && typeof item.text === 'string') as { text: string } | undefined;
	return part?.text;
}

function mapTextParts(result: Record<string, unknown>, map: (text: string) => string): Record<string, unknown> {
	if (!Array.isArray(result.content)) {
		return result;
	}
	return {
		...result,
		content: result.content.map(item => isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? { ...item, text: map(item.text) } : item),
	};
}

/**
 * 子プロセスの結果を、エージェントへ返す形に直す。
 * @param recentRejection この呼び出しの間にゲートウェイが入力を断った理由（あれば）。
 */
export function paradisAdjustDevtoolsToolResult(name: string, prepared: IParadisPreparedDevtoolsCall, result: unknown, recentRejection?: string): unknown {
	if (!isRecord(result)) {
		return result;
	}
	if (result.isError === true) {
		if (recentRejection !== undefined && INPUT_TOOLS.has(name)) {
			const reason = recentRejection;
			return mapTextParts(result, text => text.includes('PARA_BROWSER_') ? text : `${text}\nPara Code refused the input during this call: ${reason}`);
		}
		return result;
	}
	if (name === 'wait_for') {
		return mapTextParts(result, prepared.includeSnapshot === true ? text => limitSnapshot(text, 0) : stripSnapshot);
	}
	if (name === 'take_snapshot') {
		if (prepared.snapshotRoot !== undefined) {
			const root = prepared.snapshotRoot;
			const missing = Array.isArray(result.content) && result.content.some(item => isRecord(item) && item.type === 'text' && typeof item.text === 'string' && item.text.includes(SNAPSHOT_HEADING) && paradisSnapshotSubtree(item.text, root) === undefined);
			if (missing) {
				return { content: [{ type: 'text', text: `The element uid=${root} is not in the current snapshot (uids change when the page changes). Call take_snapshot without "root" to get fresh uids.` }], isError: true };
			}
			return mapTextParts(result, text => limitSnapshot(paradisSnapshotSubtree(text, root) ?? text, prepared.snapshotOffset ?? 0, root));
		}
		return mapTextParts(result, text => limitSnapshot(text, prepared.snapshotOffset ?? 0));
	}
	return result;
}

/** evaluate_script の中の `.click()` を見分ける（文字列やコメントの中も拾うが、足すのは 1 行の案内だけ）。 */
const SCRIPT_CLICK_PATTERN = /\.click\s*\(/;

/** evaluate_script の中で `.click()` を使ったときに結果へ足す案内（q.html Q299 A の 1 段目）。 */
export const PARADIS_SCRIPT_CLICK_HINT = 'Tip: use click_by (role + name, text or selector) instead of .click() in evaluate_script; it shows the user your cursor moving to the element, works with React/MUI, and explains why an element cannot be clicked.';

/**
 * エージェントの evaluate_script の結果に、中で `.click()` を使っていたら案内を 1 行足す。それ以外の道具・
 * 失敗した結果・形の違う結果はそのまま返す。Para Code が中で使う evaluate_script には使わない（結果を読むため）。
 */
export function paradisWithScriptClickHint(name: string, args: unknown, result: unknown): unknown {
	if (name !== 'evaluate_script' || !isRecord(result) || result.isError === true || !Array.isArray(result.content)) {
		return result;
	}
	const source = isRecord(args) && typeof args.function === 'string' ? args.function : undefined;
	if (source === undefined || !SCRIPT_CLICK_PATTERN.test(source)) {
		return result;
	}
	return { ...result, content: [...result.content, { type: 'text', text: PARADIS_SCRIPT_CLICK_HINT }] };
}

/** vendored の take_snapshot が root の要素の位置を書く行の印（PARA-PATCH。tools/snapshot.js）。 */
export const PARADIS_SNAPSHOT_ROOT_RECT_MARKER = '[Para Code root rect] ';

/** vendored の take_snapshot のスキーマが、Para Code の測りの引数を知っているか（PARA-PATCH が当たっているか）。 */
export function paradisSnapshotMeasuresRoot(tools: readonly unknown[]): boolean {
	const tool = tools.find(candidate => isRecord(candidate) && candidate.name === 'take_snapshot');
	return isRecord(tool) && isRecord(tool.inputSchema) && isRecord(tool.inputSchema.properties) && tool.inputSchema.properties.paraCodeRootRect !== undefined;
}

type IParadisSnapshotRootRect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/** エージェントへ返す結果 → 測った root の位置。結果の本文には書かない（ページの文字で偽れないように）。 */
const snapshotRootRects = new WeakMap<object, IParadisSnapshotRootRect>();

/** {@link paradisTakeSnapshotRootRect} で取り出した位置を、エージェントへ返す結果に結び付ける。 */
export function paradisAttachSnapshotRootRect(result: unknown, rect: IParadisSnapshotRootRect | undefined): void {
	if (rect && isRecord(result)) {
		snapshotRootRects.set(result, rect);
	}
}

/** take_snapshot の結果に結び付けた root の位置（測っていなければ undefined）。 */
export function paradisSnapshotRootRectOf(result: unknown): IParadisSnapshotRootRect | undefined {
	return isRecord(result) ? snapshotRootRects.get(result) : undefined;
}

/**
 * `paraCodeRootRect` を付けて呼んだ take_snapshot の結果から、vendored が書いた root の要素の位置の行を取り除き、
 * 位置（ビューポートの CSS ピクセル）を返す。見るのは `## Latest page snapshot` の見出しより前の、最初に見つかった
 * 1 行だけ（スナップショットの本文はページの文字をエスケープせずに含むので、本文の行は読まない）。
 */
export function paradisTakeSnapshotRootRect(result: unknown): { readonly result: unknown; readonly rect?: IParadisSnapshotRootRect } {
	if (!isRecord(result) || !Array.isArray(result.content)) {
		return { result };
	}
	let rect: IParadisSnapshotRootRect | undefined;
	let removed: string | undefined;
	const content = result.content.map(item => {
		if (removed !== undefined || !isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') {
			return item;
		}
		const heading = item.text.indexOf(SNAPSHOT_HEADING);
		const head = heading < 0 ? item.text : item.text.slice(0, heading);
		const lines = head.split('\n');
		const index = lines.findIndex(line => line.startsWith(PARADIS_SNAPSHOT_ROOT_RECT_MARKER));
		if (index < 0) {
			return item;
		}
		removed = lines[index];
		try {
			const value: unknown = JSON.parse(removed.slice(PARADIS_SNAPSHOT_ROOT_RECT_MARKER.length));
			if (isRecord(value) && [value.x, value.y, value.width, value.height].every(n => typeof n === 'number' && Number.isFinite(n)) && (value.width as number) > 0 && (value.height as number) > 0) {
				rect = { x: value.x as number, y: value.y as number, width: value.width as number, height: value.height as number };
			}
		} catch {
			// 読めない行は捨てるだけ
		}
		lines.splice(index, 1);
		return { ...item, text: lines.join('\n') + (heading < 0 ? '' : item.text.slice(heading)) };
	});
	if (removed === undefined) {
		return { result };
	}
	// structuredContent（vendored の --experimental-structured-content。Para Code は付けないが念のため）からも同じ行を取り除く
	const line = removed;
	const structured = isRecord(result.structuredContent) && typeof result.structuredContent.message === 'string'
		? { structuredContent: { ...result.structuredContent, message: result.structuredContent.message.split('\n').filter(candidate => candidate !== line).join('\n') } }
		: {};
	return { result: { ...result, content, ...structured }, ...(rect ? { rect } : {}) };
}

/**
 * スナップショットの本文を、`root` の uid の行とその子孫の行だけにする（字下げを詰める）。本文が無ければ
 * そのまま、`root` の行が無ければ undefined。
 */
export function paradisSnapshotSubtree(text: string, root: string): string | undefined {
	const index = text.indexOf(SNAPSHOT_HEADING);
	if (index < 0) {
		return text;
	}
	const bodyStart = index + SNAPSHOT_HEADING.length + (text[index + SNAPSHOT_HEADING.length] === '\n' ? 1 : 0);
	const lines = text.slice(bodyStart).split('\n');
	const marker = `uid=${root}`;
	const start = lines.findIndex(line => {
		const trimmed = line.trimStart();
		return trimmed === marker || trimmed.startsWith(`${marker} `);
	});
	if (start < 0) {
		return undefined;
	}
	const indent = lines[start].length - lines[start].trimStart().length;
	const kept = [lines[start].slice(indent)];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim().length === 0 || line.length - line.trimStart().length <= indent) {
			break;
		}
		kept.push(line.slice(indent));
	}
	return `${text.slice(0, bodyStart)}${kept.join('\n')}\n`;
}

function stripSnapshot(text: string): string {
	const index = text.indexOf(SNAPSHOT_HEADING);
	if (index < 0) {
		return text;
	}
	return `${text.slice(0, index).trimEnd()}\n(Snapshot omitted. Call take_snapshot, or pass includeSnapshot: true, when you need element uids.)`;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xD800 && code <= 0xDBFF;
}

function limitSnapshot(text: string, offset: number, root?: string): string {
	const index = text.indexOf(SNAPSHOT_HEADING);
	if (index < 0) {
		return text;
	}
	const bodyStart = index + SNAPSHOT_HEADING.length + (text[index + SNAPSHOT_HEADING.length] === '\n' ? 1 : 0);
	const head = text.slice(0, bodyStart);
	const body = text.slice(bodyStart);
	if (offset === 0 && body.length <= PARADIS_SNAPSHOT_MAX_CHARS) {
		return text;
	}
	if (offset >= body.length) {
		return `${head}(The snapshot has ${body.length} characters; offset ${offset} is past its end. Call take_snapshot without offset to start over.)`;
	}
	let end = Math.min(body.length, offset + PARADIS_SNAPSHOT_MAX_CHARS);
	if (end < body.length) {
		// 行の途中で切らない（uid の行が半分になると読み違える）
		const lineEnd = body.lastIndexOf('\n', end);
		if (lineEnd > offset) {
			end = lineEnd + 1;
		} else if (isHighSurrogate(body.charCodeAt(end - 1))) {
			// 1 行が上限より長いときは文字の途中で切る。サロゲートペアの片方だけを残さない。
			end--;
		}
	}
	const part = body.slice(offset, end);
	const note = end < body.length
		? `\n[Para Code: snapshot truncated. Showing characters ${offset}-${end} of ${body.length}. Call take_snapshot with "offset": ${end}${root !== undefined ? ` and the same "root"` : ''} for the next part (uids stay the same while the page does not change), or pass "filePath" to save the whole snapshot to a file.]`
		: `\n[Para Code: end of snapshot. Showing characters ${offset}-${end} of ${body.length}.]`;
	return `${head}${part}${note}`;
}

/**
 * 控えたスナップショットを使ってよい呼び出しか。`verbose`（中身が違う）と `filePath`（ファイルへ書く）は
 * 毎回取り直す。
 */
export function paradisSnapshotCacheUsable(name: string, prepared: IParadisPreparedDevtoolsCall): boolean {
	if (name !== 'take_snapshot' && name !== 'wait_for') {
		return false;
	}
	return !isRecord(prepared.args) || (prepared.args.verbose !== true && prepared.args.filePath === undefined);
}

/** 控えたスナップショットから続きを切り出し、いつ取ったものかを注記する。 */
export function paradisAdjustCachedSnapshotResult(prepared: IParadisPreparedDevtoolsCall, cached: unknown, takenAt: number): unknown {
	const adjusted = paradisAdjustDevtoolsToolResult('take_snapshot', prepared, cached);
	if (!isRecord(adjusted)) {
		return adjusted;
	}
	const note = `\n[Para Code: this part comes from the snapshot taken at ${new Date(takenAt).toISOString()}. Call take_snapshot without offset for a fresh one.]`;
	return mapTextParts(adjusted, text => text.includes(SNAPSHOT_HEADING) ? `${text}${note}` : text);
}

/** 続き（`offset`）を取る呼び出しが、同じスナップショットを読めるように控えておく時間。 */
export const PARADIS_SNAPSHOT_CACHE_MS = 60_000;
const MAX_CACHED_SNAPSHOTS = 8;
const MAX_SNAPSHOT_EPOCHS = 256;

/**
 * 上限より長かったスナップショットの結果を、ペインごとに直近 1 件だけ短時間控える。`take_snapshot` の
 * `offset` 付きの呼び出しは、取り直さずにこれを切り出す（取り直すとページが変わって続きがずれる）。
 */
export class ParadisSnapshotCache {
	private readonly entries = new Map<string, { readonly result: unknown; readonly at: number; readonly child: object; readonly generation: number }>();
	/** ペインごとに、控えを捨てた回数。呼び出しの始めに読み、終わりで変わっていたら控えない。 */
	private readonly epochs = new Map<string, number>();

	constructor(private readonly now: () => number = Date.now) { }

	/** 呼び出しの始めに読む。{@link remember} に渡す。 */
	epoch(token: string): number {
		return this.epochs.get(token) ?? 0;
	}

	/**
	 * 結果にスナップショットがあり、上限より長いときだけ控える。どの子プロセス（`child`、その世代
	 * `generation`）が取ったものかも控え、同じ子プロセスへの続きの呼び出しにだけ返す。呼び出しの間に
	 * {@link forget} されていたら（`epoch` が変わっていたら）控えない。
	 */
	remember(token: string, result: unknown, child: object, generation: number, epoch: number): void {
		if (epoch !== this.epoch(token)) {
			return;
		}
		if (!isRecord(result) || result.isError === true || !Array.isArray(result.content)) {
			return;
		}
		const long = result.content.some(item => {
			if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') {
				return false;
			}
			const index = item.text.indexOf(SNAPSHOT_HEADING);
			return index >= 0 && item.text.length - index > PARADIS_SNAPSHOT_MAX_CHARS;
		});
		this.entries.delete(token);
		if (!long) {
			return;
		}
		if (this.entries.size >= MAX_CACHED_SNAPSHOTS) {
			const oldest = this.entries.keys().next();
			if (!oldest.done) {
				this.entries.delete(oldest.value);
			}
		}
		this.entries.set(token, { result, at: this.now(), child, generation });
	}

	/** 控えた結果と、それを取った時刻（ミリ秒）。古い・別の子プロセスや世代のものなら undefined。 */
	recall(token: string, child: object | undefined, generation: number): { readonly result: unknown; readonly at: number } | undefined {
		const entry = this.entries.get(token);
		if (entry === undefined || this.now() - entry.at > PARADIS_SNAPSHOT_CACHE_MS || entry.child !== child || entry.generation !== generation) {
			this.entries.delete(token);
			return undefined;
		}
		return entry;
	}

	forget(token: string): void {
		this.entries.delete(token);
		if (!this.epochs.has(token) && this.epochs.size >= MAX_SNAPSHOT_EPOCHS) {
			// 捨てた数を忘れると、進行中の呼び出しの epoch と食い違う（控えない側に倒れるだけ）。
			const oldest = this.epochs.keys().next();
			if (!oldest.done) {
				this.epochs.delete(oldest.value);
			}
		}
		this.epochs.set(token, this.epoch(token) + 1);
	}

	clear(): void {
		this.entries.clear();
		this.epochs.clear();
	}
}
