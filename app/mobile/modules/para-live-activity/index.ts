// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Live Activity の中身（案 D「状態で切り替え」）。Swift 側の `ParaCodeActivityAttributes.ContentState`
 * （`native/ParaCodeWidgets/ParaCodeActivityAttributes.swift` と、アプリ側の同名コピー
 * `ios/ParaLiveActivityModule.swift`）と同じ形にすること。時刻はすべて epoch ミリ秒の数値で渡す
 * （Date の JSON 表現の取り違えを避けるため。段階 2 のプッシュでも同じ数値をそのまま載せる）。
 *
 * 形を変えるときは JS（ここと `src/liveActivityState.ts`）と Swift の2か所を必ず一緒に直す。
 * 静的属性と合わせて 4KB を超えないこと（`src/liveActivityState.ts` の `fitLiveActivityBudget`）。
 */
export type LiveActivityPhase = 'attention' | 'running' | 'done' | 'offline';

/** 要対応の1件（許可待ち・質問）。 */
export interface LiveActivityAttentionItem {
	/** PC のターミナルの論理 ID（押したときの行き先）。 */
	key: string;
	/** スペース（ワークスペース）の ID。分からなければ無し（PC の画面を開く）。 */
	space?: string;
	/** ターミナルの名前（作業名）。 */
	name: string;
	kind: 'permission' | 'question';
	/** 今の状態になったのをこの端末が見た時刻。分からなければ無し。 */
	since?: number;
	/** 許可待ちのツール名（Bash など）。 */
	tool?: string;
	/** 許可待ちのコマンド、または質問文。 */
	detail?: string;
}

/** 実行中の1件。 */
export interface LiveActivityRunningItem {
	key: string;
	space?: string;
	name: string;
	since?: number;
	/** 最後のツールと、その対象（会話を開いたことのあるエージェントだけ分かる）。 */
	tool?: string;
	target?: string;
}

/** この Live Activity の間に終わった1件。 */
export interface LiveActivityDoneItem {
	key: string;
	space?: string;
	name: string;
	/** 終わったのを見た時刻。 */
	at?: number;
	/** かかった時間（ミリ秒）。始まりを見ていなければ無し。 */
	took?: number;
}

export interface LiveActivityState {
	phase: LiveActivityPhase;
	waitingCount: number;
	runningCount: number;
	/** この Live Activity の間に終わって、まだ未確認のもの。 */
	doneCount: number;
	/** 古い順に最大 2 件。 */
	attention: LiveActivityAttentionItem[];
	/** 最大 2 件。 */
	running: LiveActivityRunningItem[];
	/** 新しい順に最大 3 件。 */
	done: LiveActivityDoneItem[];
	/** PC 本体のバッテリー（旧 PC では未配信）。level は 0〜100。 */
	battery?: { level: number; charging: boolean };
	/** この中身を作った時刻。staleDate の起点。 */
	updatedAt: number;
	/** オフラインのとき、PC を最後に見た時刻。 */
	asOf?: number;
	/** 完了の要約が消える時刻。 */
	endsAt?: number;
}

/** 開始時に固定される静的属性（変わったら Live Activity を作り直す）。 */
export interface LiveActivityAttributes {
	pcId: string;
	pcName: string;
}

interface NativeModuleShape {
	isSupported(): boolean;
	/** 無ければ開始、同じ PC のものがあれば更新する（ほかは終える）。staleAt は epoch ms。 */
	upsert?(attributesJson: string, stateJson: string, staleAt: number | null): Promise<void>;
	/** 最後の中身を載せて終え、dismissAt（epoch ms）までロック画面に残す。 */
	finish?(stateJson: string, dismissAt: number): Promise<void>;
	/** 終える。includeFinished が false なら、完了の要約として残しているもの（終了済み）は消さない。 */
	end(includeFinished: boolean): Promise<void>;
	// ウィジェット（App Group の要約ファイル）。古いビルドには無いので optional にしておく。
	widgetStoreAvailable?(): boolean;
	writeWidgetFile?(name: string, contents: string): Promise<void>;
	writeWidgetFileIfUnchanged?(name: string, expected: string | null, contents: string): Promise<boolean>;
	readWidgetFile?(name: string): Promise<string | null>;
	removeWidgetOutboxEntries?(entriesJson: string): Promise<void>;
	reloadWidgets?(kinds: string[]): void;
}

// Expo Go 等ネイティブモジュールが無い環境では null（全APIがno-opになる）。
const native = requireOptionalNativeModule<NativeModuleShape>('ParaLiveActivity');

export function isLiveActivitySupported(): boolean {
	return native?.isSupported() ?? false;
}

/**
 * Live Activity が無ければ開始し、あれば中身を更新する。静的属性（PC）が違うものは終えて作り直す。
 * `staleAt` を過ぎると表示が「古い」に変わる（アプリが止まって更新が来なくなったとき）。
 */
export async function upsertLiveActivity(attributes: LiveActivityAttributes, state: LiveActivityState, staleAt: number | undefined): Promise<void> {
	await native?.upsert?.(JSON.stringify(attributes), JSON.stringify(state), staleAt ?? null);
}

/** 最後の中身（完了の要約）を載せて終え、`dismissAt` までロック画面に残す。 */
export async function finishLiveActivity(state: LiveActivityState, dismissAt: number): Promise<void> {
	await native?.finish?.(JSON.stringify(state), dismissAt);
}

/**
 * Live Activity を即時に終えて消す。`includeFinished` が false なら、完了の要約として残しているもの
 * （終了済みで、ロック画面に残っているもの）は消さない。
 */
export async function endLiveActivity(includeFinished = true): Promise<void> {
	await native?.end(includeFinished);
}

// --- ホーム画面・ロック画面のウィジェット -------------------------------------------

/** App Group に置くファイル（ネイティブ側が許す名前はこの3つだけ）。 */
export type WidgetFileName = 'widget-snapshot.json' | 'widget-settings.json' | 'widget-outbox.json';

/** ウィジェットの種類（Swift 側の `kind` と一致させる）。 */
export const WIDGET_KINDS = {
	attention: 'ParaCodeAttention',
	agents: 'ParaCodeAgents',
	pcStatus: 'ParaCodePcStatus',
	space: 'ParaCodeSpace',
} as const;

/** App Group が使えるビルドか（ウィジェットの無い古いビルド・Expo Go では false）。 */
export function isWidgetStoreAvailable(): boolean {
	return native?.widgetStoreAvailable?.() ?? false;
}

export async function writeWidgetFile(name: WidgetFileName, contents: string): Promise<void> {
	await native?.writeWidgetFile?.(name, contents);
}

/** 無ければ undefined。 */
export async function readWidgetFile(name: WidgetFileName): Promise<string | undefined> {
	const raw = await native?.readWidgetFile?.(name);
	return raw ?? undefined;
}

/**
 * ファイルがいま `expected`（読んだときの中身。無かったなら undefined）のままなら `contents` を書く。
 * 読んでから書くまでの間に通知拡張・ウィジェットが書き換えていたら書かずに false を返す（呼び出し側が読み直して合わせる）。
 * 比べて書くのは 1 回の NSFileCoordinator の中で行う。
 */
export async function writeWidgetFileIfUnchanged(name: WidgetFileName, expected: string | undefined, contents: string): Promise<boolean> {
	if (native?.writeWidgetFileIfUnchanged === undefined) {
		await native?.writeWidgetFile?.(name, contents);
		return true;
	}
	return native.writeWidgetFileIfUnchanged(name, expected ?? null, contents);
}

/**
 * 積み置き（ウィジェットの「確認済みにする」）から、片付けたものを消す。`at`（積んだ時刻）が違うもの
 * （片付けを決めた後にウィジェットで押し直して積み直したもの）は消さない。
 */
export async function removeWidgetOutboxEntries(entries: readonly { pcId: string; key: string; at: number }[]): Promise<void> {
	if (entries.length === 0) {
		return;
	}
	await native?.removeWidgetOutboxEntries?.(JSON.stringify(entries));
}

/** ウィジェットを描き直させる（kinds を空にすると全種類）。アプリが前面にいる間は予算に数えられない。 */
export function reloadWidgets(kinds: readonly string[] = []): void {
	native?.reloadWidgets?.([...kinds]);
}
