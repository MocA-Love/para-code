/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 会話の全文索引の設定キーと電文。
//
// 索引は会話の2部目のコピーになる（会話に貼った秘密情報もそこへ残る）ので、既定ではオフにし、
// セッション履歴を初めて開いたときに1回だけ案内して、本人がオンにしたときだけ作る。

/** 全文索引を作って使うか。既定はオフ（案内に答えてオンにする）。オフにすると索引は消える。 */
export const PARADIS_SESSION_INDEX_SETTING_ENABLED = 'paradis.sessionIndex.enabled';
/** 索引に入れる会話の保存日数。これより前に最後に更新された会話は索引から外す。 */
export const PARADIS_SESSION_INDEX_SETTING_RETENTION_DAYS = 'paradis.sessionIndex.retentionDays';
/** コマンドの実行結果などツールの出力も索引するか。既定はしない（秘密情報が出やすいため）。 */
export const PARADIS_SESSION_INDEX_SETTING_INCLUDE_TOOL_OUTPUT = 'paradis.sessionIndex.includeToolOutput';

export const PARADIS_SESSION_INDEX_DEFAULT_RETENTION_DAYS = 90;

/** 案内に答えたかどうか（オンでもオフでも、答えたら二度と出さない）。 */
export const PARADIS_SESSION_INDEX_CONSENT_STORAGE_KEY = 'paradis.sessionIndex.consentAnswered';

/** 索引を消してオフにするコマンド。 */
export const PARADIS_SESSION_INDEX_DELETE_COMMAND_ID = 'paradis.sessionIndex.delete';

/** shared process 内の索引ファイルの置き場所（userData からの相対）。 */
export const PARADIS_SESSION_INDEX_RELATIVE_PATH = ['paradis', 'sessionIndex', 'sessionIndex.sqlite'] as const;

export interface IParadisSessionIndexUpdateRequest {
	readonly retentionDays: number;
	readonly includeToolOutput: boolean;
}

export interface IParadisSessionIndexStatus {
	readonly exists: boolean;
	readonly files: number;
	readonly messages: number;
	readonly updating: boolean;
}
