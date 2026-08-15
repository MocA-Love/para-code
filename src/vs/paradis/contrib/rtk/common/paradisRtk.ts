/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// rtk (Rust Token Killer) CLI 連携の共有型定義。shared process 側(node/paradisRtkChannel.ts)が
// `rtk gain` の出力をこの型で返し、renderer 側(electron-browser/)が集計・描画する。
// daily/summary は `rtk gain -f json -d` の JSON をそのまま写した形(snake_case)で、
// By Command / Recent Commands はテキスト出力しか無いため shared process 側でパースした形。
// フィールド欠落に耐えるよう、生 JSON 由来の数値は undefined 許容で扱うこと。

export const PARADIS_RTK_CHANNEL = 'paradisRtk';

/**
 * rtk が PATH 上に見つからなかったことを示す目印。IPC を跨いでもエラーの message は保たれるため、
 * renderer 側はこの文字列の有無で「未インストール」と「実行はできたが失敗した」を区別する。
 */
export const PARADIS_RTK_NOT_FOUND_MARKER = 'PARADIS_RTK_NOT_FOUND';

export function isParadisRtkNotFoundError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? '');
	return message.includes(PARADIS_RTK_NOT_FOUND_MARKER);
}

/** renderer から shared process へ渡す実行オプション。CLI 引数はサービス側で固定構築する。 */
export interface IParadisRtkExecOptions {
	/** 設定 paradis.rtk.executablePath の明示パス(空なら PATH 上の `rtk` を使う)。 */
	readonly executablePath?: string;
	/** true なら shared process の結果キャッシュ(TTL)を無視して再実行する(手動更新用)。 */
	readonly bypassCache?: boolean;
}

/** `rtk gain -f json -d` の daily 1日分(rtk の JSON をそのまま写したもの)。 */
export interface IParadisRtkDailyRow {
	/** YYYY-MM-DD。 */
	readonly date: string;
	readonly commands?: number;
	readonly input_tokens?: number;
	readonly output_tokens?: number;
	readonly saved_tokens?: number;
	/** 節約率(%)。saved_tokens / input_tokens に相当する。 */
	readonly savings_pct?: number;
	readonly total_time_ms?: number;
	readonly avg_time_ms?: number;
}

/** `rtk gain -f json -d` の summary(全期間の合計)。 */
export interface IParadisRtkSummary {
	readonly total_commands?: number;
	readonly total_input?: number;
	readonly total_output?: number;
	readonly total_saved?: number;
	readonly avg_savings_pct?: number;
	readonly total_time_ms?: number;
	readonly avg_time_ms?: number;
}

/** `rtk gain` の "By Command" 表の1行(テキスト出力をパースしたもの)。 */
export interface IParadisRtkCommandRow {
	/** 表示上の幅で切り詰められて末尾が "..." になっていることがある(そのまま保持する)。 */
	readonly command: string;
	readonly count: number;
	readonly savedTokens: number;
	readonly avgSavingsPct: number;
	readonly avgTimeMs: number;
}

/** `rtk gain -H` の "Recent Commands" の1行(テキスト出力をパースしたもの)。 */
export interface IParadisRtkHistoryEntry {
	/** rtk の表示そのまま(例: "08-15 09:10")。年を持たないため Date には変換しない。 */
	readonly timestampLabel: string;
	readonly command: string;
	/** 節約率(%)。rtk は "-42%" と符号付きで出すが、ここでは大きさ(42)だけを持つ。 */
	readonly savingsPct: number;
	readonly tokens: number;
}

/** shared process チャネルのメソッドと戻り値。 */
export interface IParadisRtkService {
	/** 全期間の合計(`rtk gain -f json -d` の summary)。 */
	fetchSummary(options: IParadisRtkExecOptions): Promise<IParadisRtkSummary>;
	/** 日別の節約量(古い順)。 */
	fetchDaily(options: IParadisRtkExecOptions): Promise<IParadisRtkDailyRow[]>;
	/** コマンド別の内訳(節約量の多い順)。 */
	fetchByCommand(options: IParadisRtkExecOptions): Promise<IParadisRtkCommandRow[]>;
	/** 直近に実行されたコマンド(新しい順)。 */
	fetchRecentHistory(options: IParadisRtkExecOptions): Promise<IParadisRtkHistoryEntry[]>;
}

/** 1234567 → "1.2M"。ステータスバー・KPI・グラフ軸で同じ丸め方を使うため共有する。 */
export function paradisRtkFormatTokens(value: number): string {
	if (!isFinite(value)) {
		return '0';
	}
	if (value >= 1e9) {
		return `${(value / 1e9).toFixed(value >= 1e10 ? 0 : 1)}B`;
	}
	if (value >= 1e6) {
		return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
	}
	if (value >= 1e3) {
		return `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}K`;
	}
	return String(Math.round(value));
}
