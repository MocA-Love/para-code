/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「スペース」のビューの「プロジェクト」の見出しの上に差し込む帯（Bot の帯など）の登録口。
// 帯を持つ機能は自分の contribution から登録し、ビューは登録された帯を作って並べるだけにする。デスクトップだけの
// サービスに頼る帯（Bot の帯）は electron-browser から登録するので、Web のビューには出ない。

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { BrandedService, IConstructorSignature } from '../../../../platform/instantiation/common/instantiation.js';

export interface IParadisWorkspacesBand extends IDisposable {
	/** 帯の高さが変わった（開閉・行の増減・境の線）。ビューはツリーへの配分をやり直す。 */
	readonly onDidChangeHeight: Event<void>;
	/** ビューの高さを渡す。帯の高さが変わったら true。 */
	layout(viewHeight: number): boolean;
}

/** 帯の作り方。第 1 引数は帯を入れる入れ物。 */
export type ParadisWorkspacesBandConstructor = IConstructorSignature<IParadisWorkspacesBand, [HTMLElement]>;

const bands: ParadisWorkspacesBandConstructor[] = [];

/** 帯を登録する。ビューが作られる前（contribution の読み込みのとき）に呼ぶ。 */
export function registerParadisWorkspacesBand<Services extends BrandedService[]>(ctor: new (container: HTMLElement, ...services: Services) => IParadisWorkspacesBand): void {
	bands.push(ctor as ParadisWorkspacesBandConstructor);
}

export function paradisWorkspacesBands(): readonly ParadisWorkspacesBandConstructor[] {
	return bands;
}
