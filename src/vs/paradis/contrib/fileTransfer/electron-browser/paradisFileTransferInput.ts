/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 2 画面のファイル転送のタブ（1 ウィンドウに 1 枚）。左右で開いていた場所を覚え、再読み込みの後も
// 同じ場所から開き直す（シリアライザーが保存する）。

import { Emitter } from '../../../../base/common/event.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { PARADIS_FILE_TRANSFER_EDITOR_ID, PARADIS_FILE_TRANSFER_INPUT_TYPE_ID, ParadisTransferSide } from '../common/paradisFileTransfer.js';

/**
 * ファイル転送のマーク（案3: codicon の `files` に `arrow-swap` を重ねる）。
 * フォントの 1 文字では作れないので、既定は `files` にして、`arrow-swap` は CSS の `::after` で重ねる
 * （media/paradisFileTransfer.css の `.codicon-paradis-file-transfer`）。利用者がアイコンのテーマで
 * 別のアイコンに差し替えた場合も、重ねる矢印はそのまま付く。
 */
export const PARADIS_FILE_TRANSFER_ICON = registerIcon(
	'paradis-file-transfer',
	Codicon.files,
	localize('paradis.fileTransfer.icon', "ファイル転送のアイコン。"),
);

/** タブを開いたときに、どちらかの側に出させたい場所。 */
export interface IParadisFileTransferReveal {
	readonly side: ParadisTransferSide;
	readonly resource: URI;
}

export class ParadisFileTransferInput extends EditorInput {

	static readonly ID = PARADIS_FILE_TRANSFER_INPUT_TYPE_ID;

	private static _instance: ParadisFileTransferInput | undefined;
	static get instance(): ParadisFileTransferInput {
		if (!ParadisFileTransferInput._instance || ParadisFileTransferInput._instance.isDisposed()) {
			ParadisFileTransferInput._instance = new ParadisFileTransferInput();
		}
		return ParadisFileTransferInput._instance;
	}

	readonly resource = URI.from({ scheme: 'paradis-file-transfer', path: 'transfer' });

	/** 左右で最後に開いていた場所（シリアライザーが保存する）。 */
	readonly locations: { local: URI | undefined; remote: URI | undefined } = { local: undefined, remote: undefined };

	/** 次に開いたときにその側へ出す場所（エクスプローラーの右クリックから）。読んだら消す。 */
	private pendingReveal: IParadisFileTransferReveal | undefined;

	private readonly _onDidRequestReveal = this._register(new Emitter<void>());
	/** すでに開いているタブへ場所を出させたいとき（タブを開き直しても setInput は呼ばれない）。 */
	readonly onDidRequestReveal = this._onDidRequestReveal.event;

	override get typeId(): string {
		return ParadisFileTransferInput.ID;
	}

	override get editorId(): string {
		return PARADIS_FILE_TRANSFER_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('paradis.fileTransfer.inputName', "ファイル転送");
	}

	override getIcon(): ThemeIcon {
		return PARADIS_FILE_TRANSFER_ICON;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof ParadisFileTransferInput;
	}

	reveal(reveal: IParadisFileTransferReveal): void {
		this.pendingReveal = reveal;
		this._onDidRequestReveal.fire();
	}

	takeReveal(): IParadisFileTransferReveal | undefined {
		const reveal = this.pendingReveal;
		this.pendingReveal = undefined;
		return reveal;
	}
}

interface ISerializedFileTransferInput {
	readonly local?: string;
	readonly remote?: string;
}

/** 再読み込みの後もタブと左右の場所を戻すシリアライザー。 */
export class ParadisFileTransferInputSerializer implements IEditorSerializer {

	canSerialize(): boolean {
		return true;
	}

	serialize(input: EditorInput): string {
		const locations = input instanceof ParadisFileTransferInput ? input.locations : { local: undefined, remote: undefined };
		const value: ISerializedFileTransferInput = { local: locations.local?.toString(), remote: locations.remote?.toString() };
		return JSON.stringify(value);
	}

	deserialize(_instantiationService: IInstantiationService, raw: string): EditorInput {
		const input = ParadisFileTransferInput.instance;
		try {
			const value = JSON.parse(raw) as ISerializedFileTransferInput;
			input.locations.local ??= value.local ? URI.parse(value.local) : undefined;
			input.locations.remote ??= value.remote ? URI.parse(value.remote) : undefined;
		} catch {
			// 壊れた控えは捨てて既定の場所から開く
		}
		return input;
	}
}
