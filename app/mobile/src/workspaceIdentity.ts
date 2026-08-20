// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 直前と新しい WorkspaceState を突き合わせ、値が等しい要素・配列・全体の参照を据え置く（構造共有）。
 *
 * `mergeWorkspaceState` は complete:true のとき incoming をそのまま返す。incoming は JSON.parse
 * 由来なので全要素が新品参照になり、ターミナル1件のタイトルが変わっただけでも workspaces や
 * renderers まで別物として下流へ流れる。エージェント実行中は state が最大10Hz届くため、購読側は
 * 「本当に変わったか」を自前で確かめる回避策を書かざるを得なかった（wsDrawer.tsx・
 * markdownText.tsx・(tabs)/index.tsx の各コメント）。
 *
 * **据え置くのは配下の配列と要素であって、state 全体ではない。** PCは表示が変わったときだけ
 * revision を進め、モバイルは revision が進んでいない state を捨てるので、ここへ届く state は
 * 必ず revision が違う＝全体の参照は毎回変わる。したがって「`s.workspace` 本体を購読しては
 * いけない」という既存の助言は今も有効で、効くのは部分を購読している側（一覧・行・ドロワー）。
 * 全体の据え置きが実際に成立するのは、PC再起動直後の「新epochだがready rendererがゼロ」の
 * 部分state（mergeWorkspaceState が旧表示を保持する経路）が連続するときだけ。
 *
 * 判定は3層（要素→配列→全体）。**値が等しいときだけ前回の参照を返す**のが唯一の規則で、
 * 「undefined は変化なしとみなす」式の引き継ぎは一切しない。特に `resources` は
 * 「届かない＝このPCはもう配信しない」を意味するため（store.ts の定義コメント）、undefined を
 * 無視して前回値を残すと何時間前の値が現在のPCとして出続ける。引き継ぎが要る場面
 * （バッテリーのちらつき防止など）は `mergeWorkspaceState` の責務で、ここは触らない。
 *
 * 配列は順序も含めて比較する。`mergeWorkspaceState` は Map の挿入順で配列を作り直すため順序が
 * 変わりうるが、順序変化は画面の並びが変わる＝「変化」として扱う。
 */

import type { DesktopResources, WorkspaceNoteSummary, WorkspacePrStatus, WorkspaceState } from './store.js';

type Renderer = WorkspaceState['renderers'][number];
type Workspace = WorkspaceState['workspaces'][number];
type Terminal = WorkspaceState['terminals'][number];
type Battery = NonNullable<WorkspaceState['battery']>;

/**
 * 長さと順序が一致し、全要素が据え置けたときだけ前回の配列参照を返す。
 * 1件でも変わっていれば新しい配列を作るが、据え置けた要素は前回の参照のまま入る。
 */
function reuseArray<T extends object>(previous: T[], next: T[], reuseItem: (previousItem: T, nextItem: T) => T): T[] {
	if (previous.length !== next.length) {
		return next;
	}
	const result: T[] = new Array(next.length);
	let reusedAll = true;
	for (let i = 0; i < next.length; i++) {
		// `noUncheckedIndexedAccess` 下では要素が `T | undefined` になる。長さは一致している
		// はずなので通らない枝だが、握りつぶさずそのまま next を返して「変化あり」に倒す。
		const previousItem = previous[i];
		const nextItem = next[i];
		if (previousItem === undefined || nextItem === undefined) {
			return next;
		}
		const item = reuseItem(previousItem, nextItem);
		result[i] = item;
		if (item !== previousItem) {
			reusedAll = false;
		}
	}
	return reusedAll ? previous : result;
}

/**
 * 任意フィールドの据え置き判定。戻り値が `previous` と同一参照なら「変化なし」を意味する
 * （両方 undefined の場合も undefined === undefined で成立する）。
 */
function reusePrStatus(previous: WorkspacePrStatus | undefined, next: WorkspacePrStatus | undefined): WorkspacePrStatus | undefined {
	if (previous === undefined || next === undefined) {
		return next;
	}
	return previous.number === next.number && previous.state === next.state && previous.url === next.url
		? previous
		: next;
}

function reuseNote(previous: WorkspaceNoteSummary | undefined, next: WorkspaceNoteSummary | undefined): WorkspaceNoteSummary | undefined {
	if (previous === undefined || next === undefined) {
		return next;
	}
	return previous.open === next.open && previous.done === next.done ? previous : next;
}

function reuseBattery(previous: Battery | undefined, next: Battery | undefined): Battery | undefined {
	if (previous === undefined || next === undefined) {
		return next;
	}
	return previous.level === next.level && previous.charging === next.charging ? previous : next;
}

function reuseResources(previous: DesktopResources | undefined, next: DesktopResources | undefined): DesktopResources | undefined {
	if (previous === undefined || next === undefined) {
		return next;
	}
	return previous.cpu === next.cpu
		&& previous.memUsed === next.memUsed
		&& previous.memTotal === next.memTotal
		&& previous.diskFree === next.diskFree
		&& previous.diskTotal === next.diskTotal
		? previous
		: next;
}

function reuseRenderer(previous: Renderer, next: Renderer): Renderer {
	// host（「接続先セグメント」向け）も比較する。これを見ないと、PC側がホストラベルを
	// authority生値から整形済みへ差し替えて再送しても（onDidChangeFormatters）、
	// windowId/generation/readyが不変のため previous がそのまま採用され、
	// モバイルのピルに古いラベル（例: ssh-remote+myserver）が永久に残る。
	return previous.windowId === next.windowId
		&& previous.rendererGeneration === next.rendererGeneration
		&& previous.ready === next.ready
		&& previous.host?.kind === next.host?.kind
		&& previous.host?.id === next.host?.id
		&& previous.host?.label === next.host?.label
		? previous
		: next;
}

function reuseWorkspace(previous: Workspace, next: Workspace): Workspace {
	const pr = reusePrStatus(previous.pr, next.pr);
	const note = reuseNote(previous.note, next.note);
	return pr === previous.pr
		&& note === previous.note
		&& previous.id === next.id
		&& previous.sourceId === next.sourceId
		&& previous.windowId === next.windowId
		&& previous.name === next.name
		&& previous.color === next.color
		&& previous.branch === next.branch
		&& previous.parent === next.parent
		&& previous.pinned === next.pinned
		? previous
		: next;
}

function reuseTerminal(previous: Terminal, next: Terminal): Terminal {
	return previous.terminalKey === next.terminalKey
		&& previous.id === next.id
		&& previous.windowId === next.windowId
		&& previous.rendererGeneration === next.rendererGeneration
		&& previous.title === next.title
		&& previous.ws === next.ws
		&& previous.agent === next.agent
		&& previous.agentToken === next.agentToken
		&& previous.agentStatus === next.agentStatus
		&& previous.cols === next.cols
		&& previous.rows === next.rows
		? previous
		: next;
}

/**
 * `next` と値が等しい範囲で `previous` の参照を再利用した WorkspaceState を返す。
 * 全体が等しければ `previous` そのものを返すので、購読側は参照比較だけで無変化を判定できる。
 */
export function reuseWorkspaceState(previous: WorkspaceState | undefined, next: WorkspaceState): WorkspaceState {
	if (previous === undefined || previous === next) {
		return next;
	}
	const renderers = reuseArray(previous.renderers, next.renderers, reuseRenderer);
	const workspaces = reuseArray(previous.workspaces, next.workspaces, reuseWorkspace);
	const terminals = reuseArray(previous.terminals, next.terminals, reuseTerminal);
	const battery = reuseBattery(previous.battery, next.battery);
	const resources = reuseResources(previous.resources, next.resources);
	if (renderers === previous.renderers
		&& workspaces === previous.workspaces
		&& terminals === previous.terminals
		&& battery === previous.battery
		&& resources === previous.resources
		&& previous.protocolVersion === next.protocolVersion
		&& previous.fsUploadEncoding === next.fsUploadEncoding
		&& previous.voiceClips === next.voiceClips
		&& previous.desktopEpoch === next.desktopEpoch
		&& previous.revision === next.revision
		&& previous.complete === next.complete
		&& previous.activeWs === next.activeWs
		&& previous.pcName === next.pcName) {
		return previous;
	}
	if (renderers === next.renderers
		&& workspaces === next.workspaces
		&& terminals === next.terminals
		&& battery === next.battery
		&& resources === next.resources) {
		return next;
	}
	// 据え置けた部分だけ前回の参照へ差し替える。undefined のときにキーを増やさないよう、
	// 据え置きが起きたフィールドだけを上書きする（next のキーの有無をそのまま保つ）。
	const merged: WorkspaceState = { ...next, renderers, workspaces, terminals };
	if (battery !== next.battery) {
		merged.battery = battery;
	}
	if (resources !== next.resources) {
		merged.resources = resources;
	}
	return merged;
}
