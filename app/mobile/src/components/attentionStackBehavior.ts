// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ホーム上部「応答待ち」スタック（{@link ./attentionStack.tsx}）の並び順・開閉・件数制限を
 * 決める純関数群。画面側に散らすと「回答したら勝手に次が開く」「1件しかないのに畳まれる」
 * といった揺れが起きるため、状態遷移はすべてここに集約してテストする。
 */

/** 応答待ちの1件（並べ替えに必要な最小限だけを見る）。 */
export interface WaitingLike {
	readonly terminalKey: string;
	readonly agentStatus?: string;
}

/** 開閉状態。同時に開くのは常に1件だけ。 */
export interface AttentionOpenState {
	/** いま開いている行。undefined なら全部畳んである。 */
	readonly openKey: string | undefined;
	/**
	 * 直前の描画で応答待ちだった顔ぶれ。**新しく現れた1件だけ**を自動で開くために持つ。
	 * これが無いと「2件のうち1件に回答して残り1件になった」瞬間にも自動オープンが走り、
	 * 答えた指の真下へ次の許可カードがせり上がって誤タップになる（承認はPTY注入なので取り消せない）。
	 */
	readonly seenKeys: readonly string[];
}

/** 全部畳んだ初期状態。 */
export const CLOSED_ATTENTION: AttentionOpenState = { openKey: undefined, seenKeys: [] };

/** 上部に出す行数の上限（超えたぶんは「他N件を表示」に畳む）。 */
export const ATTENTION_VISIBLE_LIMIT = 3;

/**
 * 応答待ちの並び順。許可の確認（permission）を質問（question）より先に出し、
 * 同種のものは渡された順（PC側のターミナル順）を保つ（Array#sort は安定なのでそのまま残る）。
 *
 * 「待たせている時間が長い順」にはしない。待ち始めた時刻はPCから届かないうえ、
 * 順番が動くと押そうとした行が入れ替わるため（安定した並びを優先する）。
 */
export function sortWaiting<T extends WaitingLike>(items: readonly T[]): T[] {
	const rank = (status: string | undefined) => status === 'permission' ? 0 : 1;
	return [...items].sort((a, b) => rank(a.agentStatus) - rank(b.agentStatus));
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((key, index) => key === b[index]);
}

/**
 * 応答待ちの顔ぶれが変わったときに開閉状態を整える。
 *
 *  - 開いていた行が消えた（回答した・終わった）→ 畳む。**次の行を自動では開かない**。
 *    同じ更新で新しい1件が届いていても開かない（回答した指の下にカードを出さないため）
 *  - 新しく現れた1件だけが待っている → 自動で開く（今までの「開いた瞬間に答えられる」体験を保つ）
 *  - 前からいた1件（減って残ったもの・自分で畳んだもの）は開き直さない
 *  - 2件以上 → 自動では開かない（既に開いている行はそのまま維持する）
 *
 * `knownKeys` は「見たことがある」の記録に使う顔ぶれで、既定は `keys` と同じ。ワークスペースを
 * 絞り込んでいる画面では、絞り込み前の全応答待ちを渡すこと。`keys`（＝絞り込み後）で記録すると、
 * ドロワーで表示範囲を切り替えて戻すだけで記録が消え、畳んだ1件が勝手に開き直る。
 */
export function reconcileAttention(
	state: AttentionOpenState,
	keys: readonly string[],
	knownKeys: readonly string[] = keys,
): AttentionOpenState {
	const kept = state.openKey !== undefined && keys.includes(state.openKey) ? state.openKey : undefined;
	const resolved = state.openKey !== undefined && kept === undefined;
	const fresh = !resolved && keys.length === 1 && !state.seenKeys.includes(keys[0]!) ? keys[0] : undefined;
	const next: AttentionOpenState = {
		openKey: kept ?? fresh,
		seenKeys: sameKeys(state.seenKeys, knownKeys) ? state.seenKeys : [...knownKeys],
	};
	return next.openKey === state.openKey && next.seenKeys === state.seenKeys ? state : next;
}

/** ヘッダーをタップしたときの遷移（開いていれば畳む、別の行なら乗り換える）。 */
export function toggleAttention(state: AttentionOpenState, key: string): AttentionOpenState {
	return { openKey: state.openKey === key ? undefined : key, seenKeys: state.seenKeys };
}

/**
 * 上部に実際に描く行。既定は先頭 {@link ATTENTION_VISIBLE_LIMIT} 件までに抑え、
 * 開いている行が範囲外なら必ず含める（開いたまま消えるのを防ぐ）。並び順は保つ。
 */
export function visibleWaiting<T extends WaitingLike>(
	items: readonly T[],
	openKey: string | undefined,
	expanded: boolean,
	limit: number = ATTENTION_VISIBLE_LIMIT,
): T[] {
	if (expanded || items.length <= limit) {
		return [...items];
	}
	const shown = items.slice(0, limit);
	const open = items.find(item => item.terminalKey === openKey);
	if (open !== undefined && !shown.includes(open)) {
		shown.push(open);
	}
	return shown;
}
