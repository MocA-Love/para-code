/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process の中で、ペインの会話の記録（transcript）の行を知らせるバス。
// 記録を追いかけているのは ParadisMobileAgentChat（mobileRelay）の tailer で、チャット表示とモバイルのために読んだ行を、
// 読んだその場でここへも流す（別に読み直さない）。資料の台帳（agentDocs）が購読して、書き込みを拾う。
// hook のバス（paradisAgentHookBus.ts）と同じく、モジュールの Emitter でつなぐ（同じプロセスの中だけ。IPC は介さない）。

import { Emitter, Event } from '../../../../base/common/event.js';
import type { ParadisAgentKind } from '../../agentChat/common/paradisAgentDescriptor.js';

/** tailer が 1 回に読んだ記録の行（JSON として読めたもの。読めた順）。 */
export interface IParadisAgentTranscriptEntries {
	/** ペイントークン。 */
	readonly token: string;
	readonly agent: ParadisAgentKind;
	/** 読んだファイル（SSH の窓のペインでは、接続先の記録の手元の写し）。 */
	readonly transcriptPath: string;
	/** ペインの会話の ID（hook か探索で分かったもの）。分からなければ undefined。 */
	readonly sessionId: string | undefined;
	/** SSH の窓のペインの会話か（読んでいるのは接続先の記録の写し。行の中のパスは接続先の綴り）。 */
	readonly remote: boolean;
	/**
	 * 接続先の印（hook の remoteHostId の形）。shared process が起き直した後は、そのペインの次の hook が届くまで
	 * 分からない（`remote` なのに undefined）。
	 */
	readonly remoteHostId: string | undefined;
	/**
	 * 読み始めの番号。記録を頭から読み直す（ファイルが縮んだ・写しを作り直した・別の記録へ替わった）たびに変わる。
	 * 行をまたいで覚えている状態（結果待ちの呼び出し）は、これが変わったら捨てる。
	 */
	readonly epoch: string;
	/**
	 * 書かれてすぐ読んだ追記か。false は過去の分（初回の読み込み・読み直し・tailer より後にできたファイルの最初の読み・
	 * SSH の写しが追いつくために写した分）で、いつ書かれた行かは行の時刻でしか分からない。
	 */
	readonly live: boolean;
	readonly entries: readonly Readonly<Record<string, unknown>>[];
}

const emitter = new Emitter<IParadisAgentTranscriptEntries>();

/** 記録の行の購読（shared process の中だけ）。 */
export const onParadisAgentTranscriptEntries: Event<IParadisAgentTranscriptEntries> = emitter.event;

/** tailer が読んだ行を知らせる。 */
export function fireParadisAgentTranscriptEntries(entries: IParadisAgentTranscriptEntries): void {
	emitter.fire(entries);
}
