/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// take_snapshot の 2 回目以降を、前回との差分にする（para-browser-improvement.html の E2、Q303。既定は無効）。
//   - 内蔵 chrome-devtools-mcp の uid は、同じ文書の同じノードなら同じ値になる（TextSnapshot.js の
//     loaderId + backendNodeId）。行を uid で突き合わせれば、消えた・増えた・変わった要素が分かる
//   - 前回の控えはタブ（子プロセスの台帳のキー）ごとに 1 つ。取った子プロセスと世代が違う（uid の数え直し）、
//     根の uid が違う（別の文書）、古い、のどれかなら差分にせず全体を返す
//   - 差分が全体の半分を超えるなら全体を返す（読む量が減らないため）
//   - エージェントは `full: true` で全体を取れる。全体を返したときも控えは取り直す

/** vendored の take_snapshot が本文の前に置く見出し。 */
const SNAPSHOT_HEADING = '## Latest page snapshot';

/** 差分を返すときの見出し（全体の見出しとは別にして、全体と取り違えないようにする）。 */
export const PARADIS_SNAPSHOT_DIFF_HEADING = '## Page snapshot: changes only';

/** 前回の控えを差分の元に使う期限。過ぎたら全体を返す（エージェントの会話が要約されて uid を忘れている見込みが高い）。 */
export const PARADIS_SNAPSHOT_BASELINE_MAX_AGE_MS = 10 * 60_000;
const MAX_BASELINES = 32;
/** これより長い本文は控えない（メモリを抑える）。 */
const MAX_BASELINE_CHARS = 2_000_000;
/** 差分がこの割合を超えたら、全体を返す。 */
const MAX_DIFF_RATIO = 0.5;
/** 並び替えを知らせるときに並べる uid の数。 */
const MAX_LISTED_ORDER = 20;

const NODE_LINE = /^(?<indent> *)uid=(?<uid>\S+)/;

interface ISnapshotNode {
	readonly uid: string;
	/** 字下げを除いた行（名前に改行があれば、続きの行も含む）。 */
	text: string;
	readonly parent: string | undefined;
	readonly children: string[];
}

interface IParsedSnapshot {
	readonly root: string;
	readonly nodes: ReadonlyMap<string, ISnapshotNode>;
	/** 本文に出てくる順。 */
	readonly order: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** スナップショットの本文を読む。uid の行が無い・同じ uid が 2 回出る・字下げが飛ぶときは undefined（差分にしない）。 */
function parseSnapshot(body: string): IParsedSnapshot | undefined {
	const nodes = new Map<string, ISnapshotNode>();
	const order: string[] = [];
	const stack: string[] = [];
	let last: ISnapshotNode | undefined;
	for (const line of body.split('\n')) {
		const match = NODE_LINE.exec(line);
		if (!match?.groups) {
			// 名前に改行がある要素の続きの行。最初の要素より前の行（DevTools の注記）は比べない
			if (last !== undefined && line.length > 0) {
				last.text += `\n${line}`;
			}
			continue;
		}
		const indent = match.groups.indent.length;
		if (indent % 2 !== 0) {
			return undefined;
		}
		const depth = indent / 2;
		if (depth > stack.length || (depth === 0 && nodes.size > 0)) {
			return undefined;
		}
		stack.length = depth;
		const uid = match.groups.uid;
		if (nodes.has(uid)) {
			return undefined;
		}
		const parent = depth > 0 ? stack[depth - 1] : undefined;
		const node: ISnapshotNode = { uid, text: line.slice(indent), parent, children: [] };
		nodes.set(uid, node);
		order.push(uid);
		if (parent !== undefined) {
			nodes.get(parent)?.children.push(uid);
		}
		stack.push(uid);
		last = node;
	}
	return order.length > 0 ? { root: order[0], nodes, order } : undefined;
}

/** 要素の行の 1 行目（一覧の見出しに使う）。 */
function firstLine(text: string): string {
	const index = text.indexOf('\n');
	return index < 0 ? text : text.slice(0, index);
}

/** 字下げを付けて、要素とその子孫の行を書く。 */
function writeSubtree(snapshot: IParsedSnapshot, uid: string, depth: number, out: string[]): void {
	const node = snapshot.nodes.get(uid);
	if (!node) {
		return;
	}
	out.push(`${'  '.repeat(depth)}${node.text}`);
	for (const child of node.children) {
		writeSubtree(snapshot, child, depth + 1, out);
	}
}

function countDescendants(snapshot: IParsedSnapshot, uid: string): number {
	let count = 0;
	for (const child of snapshot.nodes.get(uid)?.children ?? []) {
		count += 1 + countDescendants(snapshot, child);
	}
	return count;
}

/**
 * 前回と今回のスナップショットの本文を比べ、エージェントへ返す差分の文を作る。差分にしない方がよいとき
 * （読めない、別の文書、差分が大きい）は undefined。
 * @param takenAt 前回のスナップショットを取った時刻（ミリ秒）。
 */
export function paradisDiffSnapshotBodies(previousBody: string, currentBody: string, takenAt: number): string | undefined {
	const previous = parseSnapshot(previousBody);
	const current = parseSnapshot(currentBody);
	if (!previous || !current || previous.root !== current.root) {
		return undefined;
	}
	const when = `${new Date(takenAt).toISOString().slice(11, 19)} UTC`;

	const removed: string[] = [];
	let removedCount = 0;
	for (const uid of previous.order) {
		if (current.nodes.has(uid)) {
			continue;
		}
		removedCount++;
		const parent = previous.nodes.get(uid)?.parent;
		if (parent === undefined || current.nodes.has(parent)) {
			const inside = countDescendants(previous, uid);
			removed.push(`- ${firstLine(previous.nodes.get(uid)!.text)}${inside > 0 ? ` (and ${inside} inside)` : ''}`);
		}
	}

	const changed: string[] = [];
	for (const uid of current.order) {
		const now = current.nodes.get(uid)!;
		const before = previous.nodes.get(uid);
		if (!before) {
			continue;
		}
		if (before.parent !== now.parent) {
			changed.push(`~ ${now.text} (moved: now inside uid=${now.parent})`);
		} else if (before.text !== now.text) {
			changed.push(`~ ${now.text}`);
		}
		// 残った子の並びが変わったか（増えた・消えた子は、それぞれの節に出る）
		const kept = now.children.filter(child => previous.nodes.get(child)?.parent === uid);
		const keptBefore = before.children.filter(child => current.nodes.get(child)?.parent === uid);
		if (kept.length > 1 && kept.some((child, index) => keptBefore[index] !== child)) {
			const listed = kept.slice(0, MAX_LISTED_ORDER).map(child => `uid=${child}`).join(', ');
			changed.push(`~ the elements inside uid=${uid} are now in this order: ${listed}${kept.length > MAX_LISTED_ORDER ? `, ... (${kept.length} in all)` : ''}`);
		}
	}

	const added: string[] = [];
	let addedCount = 0;
	for (const uid of current.order) {
		if (previous.nodes.has(uid)) {
			continue;
		}
		addedCount++;
		const node = current.nodes.get(uid)!;
		if (node.parent === undefined || !previous.nodes.has(node.parent)) {
			continue;
		}
		const siblings = current.nodes.get(node.parent)!.children;
		const index = siblings.indexOf(uid);
		const after = index > 0 ? `, after uid=${siblings[index - 1]}` : ', first';
		added.push(`+ inside uid=${node.parent}${after}:`);
		writeSubtree(current, uid, 1, added);
	}

	if (removed.length === 0 && changed.length === 0 && added.length === 0) {
		return `[Para Code: no change since your previous take_snapshot of this tab (${when}); its uids still work. full: true returns the whole page.]\n`;
	}
	const counts = [
		addedCount > 0 ? `${addedCount} added` : undefined,
		removedCount > 0 ? `${removedCount} removed` : undefined,
		changed.length > 0 ? `${changed.length} changed` : undefined,
	].filter(part => part !== undefined).join(', ');
	const lines = [
		PARADIS_SNAPSHOT_DIFF_HEADING,
		`[Para Code: changes since your previous take_snapshot of this tab (${when}): ${counts}. Unlisted elements are unchanged and keep their uids. full: true returns the whole page (use it if you have not seen that snapshot).]`,
	];
	if (removed.length > 0) {
		lines.push('Removed (these uids no longer work):', ...removed);
	}
	if (changed.length > 0) {
		lines.push('Changed:', ...changed);
	}
	if (added.length > 0) {
		lines.push('Added:', ...added);
	}
	const text = `${lines.join('\n')}\n`;
	return text.length > currentBody.length * MAX_DIFF_RATIO ? undefined : text;
}

/** take_snapshot の結果の、見出しより前と本文。見出しが無ければ undefined。 */
function splitSnapshotText(text: string): { readonly head: string; readonly body: string } | undefined {
	const index = text.indexOf(SNAPSHOT_HEADING);
	if (index < 0) {
		return undefined;
	}
	const bodyStart = index + SNAPSHOT_HEADING.length + (text[index + SNAPSHOT_HEADING.length] === '\n' ? 1 : 0);
	return { head: text.slice(0, index), body: text.slice(bodyStart) };
}

/** エージェントの take_snapshot を差分にするか（`diff`）、全体を返して控えだけ取り直すか（`full`）。 */
export type ParadisSnapshotDiffMode = 'diff' | 'full';

/**
 * エージェントが前回 take_snapshot で受け取ったページの、タブごとの控え。キーは子プロセスの台帳のキー
 * （ペインのトークン、または tab_id のスコープキー）。
 */
export class ParadisSnapshotBaselines {
	private readonly entries = new Map<string, { readonly body: string; readonly at: number; readonly child: object; readonly generation: number }>();

	constructor(private readonly now: () => number = Date.now) { }

	/**
	 * take_snapshot の結果を、`mode` に従って差分に置き換え（できるときだけ）、本文を次の控えにする。
	 * 失敗した結果・スナップショットの無い結果はそのまま返し、控えも変えない。
	 * @param child 結果を返した子プロセス。uid はこれと `generation` が同じ間だけ続けて使える。
	 */
	apply(token: string, child: object, generation: number, result: unknown, mode: ParadisSnapshotDiffMode): unknown {
		if (!isRecord(result) || result.isError === true || !Array.isArray(result.content)) {
			return result;
		}
		const index = result.content.findIndex(item => isRecord(item) && item.type === 'text' && typeof item.text === 'string' && item.text.includes(SNAPSHOT_HEADING));
		if (index < 0) {
			return result;
		}
		const parts = splitSnapshotText((result.content[index] as { text: string }).text);
		if (!parts) {
			return result;
		}
		const previous = this.entries.get(token);
		const at = this.now();
		this.entries.delete(token);
		if (parts.body.length <= MAX_BASELINE_CHARS) {
			if (this.entries.size >= MAX_BASELINES) {
				const oldest = this.entries.keys().next();
				if (!oldest.done) {
					this.entries.delete(oldest.value);
				}
			}
			this.entries.set(token, { body: parts.body, at, child, generation });
		}
		if (mode !== 'diff' || previous === undefined || previous.child !== child || previous.generation !== generation || at - previous.at > PARADIS_SNAPSHOT_BASELINE_MAX_AGE_MS) {
			return result;
		}
		const diff = paradisDiffSnapshotBodies(previous.body, parts.body, previous.at);
		if (diff === undefined) {
			return result;
		}
		const content = [...result.content];
		content[index] = { ...(content[index] as object), text: `${parts.head}${diff}` };
		// structuredContent（vendored の --experimental-structured-content。Para Code は付けない）には全体が入るので外す
		const rest = { ...result };
		delete rest.structuredContent;
		return { ...rest, content };
	}

	forget(token: string): void {
		this.entries.delete(token);
	}

	/** 条件に合うキーの控えを捨てる（新しいエージェントがつながったペインなど）。 */
	forgetWhere(predicate: (token: string) => boolean): void {
		for (const token of [...this.entries.keys()]) {
			if (predicate(token)) {
				this.entries.delete(token);
			}
		}
	}

	clear(): void {
		this.entries.clear();
	}
}

/** 差分の設定が有効なときに tools/list で出す take_snapshot（`full` を足し、説明に 1 文足す）。 */
export function paradisWithSnapshotDiffArgument<T extends { readonly name: string; readonly description?: string; readonly inputSchema?: unknown }>(tool: T): T {
	if (tool.name !== 'take_snapshot' || !isRecord(tool.inputSchema) || !isRecord(tool.inputSchema.properties)) {
		return tool;
	}
	return {
		...tool,
		description: `${tool.description ?? ''} From the second call on a tab, the response lists only what changed since your previous take_snapshot of that tab; elements not listed are unchanged and keep their uids, so keep using them.`.trim(),
		inputSchema: {
			...tool.inputSchema,
			properties: {
				...tool.inputSchema.properties,
				full: {
					type: 'boolean',
					description: 'Only when you no longer have the previous snapshot of this tab (for example in a new subagent, or after your context was summarized): return the whole snapshot instead of the changes. Default false; the changes are enough otherwise.',
				},
			},
		},
	};
}

/**
 * エージェントの take_snapshot の引数から `full` を取り除き（vendored は知らない引数を断る）、どう返すかを決める。
 */
export function paradisTakeSnapshotDiffMode(args: unknown): { readonly args: unknown; readonly mode: ParadisSnapshotDiffMode } {
	if (!isRecord(args) || !Object.hasOwn(args, 'full')) {
		return { args, mode: 'diff' };
	}
	const { full, ...rest } = args;
	return { args: rest, mode: full === true ? 'full' : 'diff' };
}
