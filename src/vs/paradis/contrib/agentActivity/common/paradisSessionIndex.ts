/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 会話の全文索引の設定キーと電文。
//
// 何もしなくても検索が強くなるよう既定でオンにする（確認は出さない）。索引は会話の2部目のコピーに
// なり、会話に貼った秘密情報もそこへ残るので、そのことを設定の説明に明記し、オフにしたら索引を消す。

/** 全文索引を作って使うか。既定はオン。オフにすると索引は消える。 */
export const PARADIS_SESSION_INDEX_SETTING_ENABLED = 'paradis.sessionIndex.enabled';
/** 索引に入れる会話の保存日数。これより前に最後に更新された会話は索引から外す。 */
export const PARADIS_SESSION_INDEX_SETTING_RETENTION_DAYS = 'paradis.sessionIndex.retentionDays';
/** コマンドの実行結果などツールの出力も索引するか。既定はしない（秘密情報が出やすいため）。 */
export const PARADIS_SESSION_INDEX_SETTING_INCLUDE_TOOL_OUTPUT = 'paradis.sessionIndex.includeToolOutput';

export const PARADIS_SESSION_INDEX_DEFAULT_RETENTION_DAYS = 90;

/** 索引を消してオフにするコマンド。 */
export const PARADIS_SESSION_INDEX_DELETE_COMMAND_ID = 'paradis.sessionIndex.delete';

/** shared process 内の索引ファイルの置き場所（userData からの相対）。 */
export const PARADIS_SESSION_INDEX_RELATIVE_PATH = ['paradis', 'sessionIndex', 'sessionIndex.sqlite'] as const;

/** 索引で探せる最短の語（trigram なので 3 文字）。これより短い語を含む検索は従来の方法で探す。 */
export const PARADIS_SESSION_INDEX_MIN_TERM_LENGTH = 3;

export interface IParadisSessionIndexSearchMatch {
	readonly catalogId: string;
	/** 本文に含まれていた検索語の位置（{@link IParadisSessionIndexSearchResult.terms} の添字）。 */
	readonly terms: readonly number[];
	readonly matchCount: number;
	readonly snippet: string;
}

export interface IParadisSessionIndexSearchResult {
	/** 検索語（小文字化・重複除去済み）。 */
	readonly terms: readonly string[];
	/** 渡された catalogId のうち、索引に入っていないもの（呼び出し側が従来の方法で探す）。 */
	readonly uncovered: readonly string[];
	/** いずれかの検索語を本文に含む会話。どの語を含んだかは `terms` で返す。 */
	readonly matches: readonly IParadisSessionIndexSearchMatch[];
}

export interface IParadisSessionIndexStatus {
	readonly exists: boolean;
	readonly files: number;
	readonly messages: number;
	readonly updating: boolean;
}
