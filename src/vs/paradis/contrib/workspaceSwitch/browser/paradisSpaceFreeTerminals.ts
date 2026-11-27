/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// どのスペースにも属さないエディタのターミナル（今は Bot の会話のペイン。報告書の D3 (a)）の台帳。
//
// - スペースの切り替えは、このターミナルのタブを退避（park）・working set の保存の対象にしない。切り替えの直前にタブを
//   外して握り（retain）、切り替え先の画面へ開き直す（paradisWorkspaceSwitchService.ts）。
// - ターミナルの所属の台帳（paradisTerminalScope.contribution.ts）は、このターミナルに所属を付けず、尋ねられたら下部パネルの
//   共通ターミナルと同じく「今のスペース」と答える。控えた時点で付いていた所属は捨てる（{@link onDidMarkTerminalSpaceFree}）。
//
// 番号（instanceId）は使い回されないので、終わったものが残っても害は無い。再読み込みの後は Bot の側が控え直す。
//
// ターミナルでないタブも、種類（typeId）で同じ扱いにできる（今は眠った Bot の会話を読むだけのタブ）。切り替えはそのタブも
// 外して持ち越し、working set に載せない。

import { Emitter, Event } from '../../../../base/common/event.js';

const spaceFree = new Set<number>();
const onDidMark = new Emitter<number>();

/** 新しく控えたターミナル（所属の台帳が、付いていた所属を捨てるために聞く）。 */
export const onDidMarkTerminalSpaceFree: Event<number> = onDidMark.event;

/** どのスペースにも属さないターミナルとして控える。初めて控えたときだけ知らせる。 */
export function paradisMarkTerminalSpaceFree(instanceId: number): void {
	if (spaceFree.has(instanceId)) {
		return;
	}
	spaceFree.add(instanceId);
	onDidMark.fire(instanceId);
}

export function paradisIsTerminalSpaceFree(instanceId: number): boolean {
	return spaceFree.has(instanceId);
}

const spaceFreeEditorTypes = new Set<string>();

/** その種類のタブを、どのスペースにも属さないタブとして扱う（読み込んだときに 1 回登録する）。 */
export function paradisRegisterSpaceFreeEditorType(typeId: string): void {
	spaceFreeEditorTypes.add(typeId);
}

/** どのスペースにも属さない種類のタブか。 */
export function paradisIsSpaceFreeEditor(editor: { readonly typeId: string }): boolean {
	return spaceFreeEditorTypes.has(editor.typeId);
}

/** テスト用にターミナルの台帳を空にする（タブの種類の登録は、読み込んだときの 1 回なので残す）。 */
export function paradisResetSpaceFreeTerminalsForTest(): void {
	spaceFree.clear();
}
