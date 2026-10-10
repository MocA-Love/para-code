/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 詰まった後にうまくいったとき、分かったことをサイトメモ（E4）や手順（E3）に残せると 1 行添える（q.html Q327 B）。
// エージェントは道具の説明だけでは自分からメモを書かなかった（台で 16 回中 0 回）ので、書く理由がある場面で知らせる。
//
// 決め事:
// - 「詰まった」は、同じタブで操作の道具がエラーを返したとき、または同じ操作（道具と相手の要素が同じ）を続けて
//   やり直したとき（キーを押す・文字を打つなど、続けて呼ぶのが普通の道具は除く）。その後に別の操作が成功したら、
//   うまくいったとみなして添える
// - 読むだけの道具（take_snapshot・get_text など）は数えない（詰まった後に読み直すのは普通のこと）
// - 同じペインで添えるのは {@link PARADIS_SITE_NUDGE_MAX_PER_AGENT} 回まで。新しいエージェントがつながったら数え直す

/** 添える数の上限（1 つのエージェントにつき）。 */
export const PARADIS_SITE_NUDGE_MAX_PER_AGENT = 3;
/** 覚えておくタブの数の上限。 */
const MAX_TABS = 256;

/** 操作の道具（成功・失敗を数える）。 */
export const PARADIS_SITE_NUDGE_ACTION_TOOLS: ReadonlySet<string> = new Set([
	'click', 'click_by', 'click_at', 'fill', 'fill_by', 'fill_form', 'type_text', 'press_key', 'hover', 'drag', 'mouse_action',
	'navigate_page', 'evaluate_script', 'handle_dialog', 'upload_file', 'download_by_click', 'wait_until', 'wait_for', 'run_steps',
]);

/** 同じ引数で続けて呼ぶのが普通の道具（Tab を何回か押す、続けて文字を打つ）。やり直しとは数えない。 */
const REPEATABLE_TOOLS: ReadonlySet<string> = new Set(['press_key', 'type_text', 'hover', 'mouse_action']);

/** 相手の要素を表さない引数（入れる値や待ち時間）。やり直しかどうかは、これを除いた引数で見る。 */
const NON_TARGET_ARGUMENTS: ReadonlySet<string> = new Set(['value', 'includeSnapshot', 'timeout', 'timeout_seconds', 'interval_ms', 'settle_ms', 'tab_id']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 道具と相手の要素の組（同じなら、同じ操作のやり直し）。 */
function actionSignature(tool: string, args: unknown): string {
	const target = isRecord(args) ? Object.fromEntries(Object.entries(args).filter(([key]) => !NON_TARGET_ARGUMENTS.has(key)).sort(([a], [b]) => a.localeCompare(b))) : {};
	return `${tool}\n${JSON.stringify(target)}`;
}

/**
 * タブごとに、詰まっているかを覚える。キーは「ペイン\nタブ」。
 */
export class ParadisSiteNudges {
	private readonly tabs = new Map<string, { struggling: boolean; last?: string }>();
	private readonly shown = new Map<string, number>();

	/**
	 * 操作の結果を 1 つ数え、1 行添えるときは true。
	 * @param pane ペインのトークン（添えた数を数える単位）。
	 * @param tab タブ（tab_id を省いたときは既定のタブ）。
	 */
	observe(pane: string, tab: string, tool: string, args: unknown, failed: boolean): boolean {
		if (!PARADIS_SITE_NUDGE_ACTION_TOOLS.has(tool)) {
			return false;
		}
		const key = `${pane}\n${tab}`;
		const state = this.tabs.get(key) ?? { struggling: false };
		this.tabs.delete(key);
		this.tabs.set(key, state);
		if (this.tabs.size > MAX_TABS) {
			this.tabs.delete(this.tabs.keys().next().value!);
		}
		const signature = actionSignature(tool, args);
		if (failed || (state.last === signature && !REPEATABLE_TOOLS.has(tool))) {
			// エラー、または同じ操作のやり直し
			state.struggling = true;
			state.last = signature;
			return false;
		}
		const recovered = state.struggling;
		state.struggling = false;
		state.last = signature;
		if (!recovered) {
			return false;
		}
		const count = this.shown.get(pane) ?? 0;
		if (count >= PARADIS_SITE_NUDGE_MAX_PER_AGENT) {
			return false;
		}
		this.shown.set(pane, count + 1);
		return true;
	}

	/** ペインの記録を捨てる（新しいエージェントがつながったとき、ペインを片付けたとき）。 */
	forget(pane: string): void {
		this.shown.delete(pane);
		for (const key of [...this.tabs.keys()]) {
			if (key.startsWith(`${pane}\n`)) {
				this.tabs.delete(key);
			}
		}
	}
}

/** 添える 1 行。使える道具（設定がオンのもの）だけを挙げる。 */
export function paradisSiteNudgeText(kinds: { readonly notes: boolean; readonly recipes: boolean }): string | undefined {
	const ways = [kinds.notes ? 'a short note with write_site_note' : undefined, kinds.recipes ? 'the steps with save_recipe' : undefined].filter(way => way !== undefined);
	if (ways.length === 0) {
		return undefined;
	}
	return `[Para Code] You got past a failed or repeated step on this site. Before you go on, record what made it work in ${ways.join(', or ')} (one short call, for example the input format or the element that worked), so the next agent does not repeat the trouble. Do not include secrets or values that only apply to this run.`;
}
