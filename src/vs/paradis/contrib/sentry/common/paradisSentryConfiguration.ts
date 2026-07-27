/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export const PARADIS_SENTRY_DESKTOP_DSN = 'https://c854d2571bf85beb19b9a8abd94240aa@o4511131276804096.ingest.us.sentry.io/4511784070676480';
/**
 * 配布ビルドの environment。
 *
 * 'development' 固定だった頃は、パッケージ版の実使用も VSCODE_DEV 以外は全部 development に
 * なり、実ユーザーが踏んだ障害とローカル検証のノイズが Sentry 上で区別できなかった
 * （production という環境自体が存在しなかった）。ソースから起動した開発ビルドは各プロセスの
 * init 側で 'local' に振り分ける。
 */
export const PARADIS_SENTRY_ENVIRONMENT = 'production';

export function paradisSentryRelease(version: string, commit?: string): string {
	return `para-code@${version}${commit ? `+${commit}` : ''}`;
}
