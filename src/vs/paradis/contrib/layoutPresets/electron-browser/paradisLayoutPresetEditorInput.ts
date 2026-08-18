/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// レイアウトプリセット編集エディタの EditorInput。
//
// **編集中の下書きは EditorPane ではなく、この input が持つ**。EditorPane は同じグループの
// 別タブへ切り替えるだけで setInput をやり直されるので、pane 側に置くと編集途中の枠が消える。
// input はタブが閉じられるまで生き続けるので、下書きの置き場所はここが正しい。

import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ConfirmResult, IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput, IEditorCloseHandler } from '../../../../workbench/common/editor/editorInput.js';
import {
	IParadisLayoutPresetDefinition,
	IParadisLayoutPresetService,
	IParadisResolvedLayoutPreset,
	paradisLayoutPresetFingerprint,
} from '../common/paradisLayoutPresets.js';

export const PARADIS_LAYOUT_PRESET_EDITOR_ID = 'paradis.editor.layoutPresetEditor';
export const PARADIS_LAYOUT_PRESET_INPUT_TYPE_ID = 'paradis.input.layoutPresetEditor';

/** 新規プリセットの初期状態（1枠だけの白紙）。 */
export function paradisEmptyLayoutPreset(): IParadisLayoutPresetDefinition {
	return {
		// allow-any-unicode-next-line
		name: localize('paradis.layoutPresets.newName', "新しいレイアウト"),
		orientation: 'columns',
		root: [{ slot: { kind: 'empty' } }],
	};
}

/** 保存されたことのない下書きの指紋（どんな中身の指紋とも一致しない番兵）。 */
const NEVER_SAVED = ' never-saved';

let newInputCounter = 0;

/** 解決済みプリセットから、保存できる素の定義部分だけを取り出す（sourceIndex / key を落とす）。 */
function cloneDefinition(preset: IParadisLayoutPresetDefinition): IParadisLayoutPresetDefinition {
	return {
		id: preset.id,
		name: preset.name,
		description: preset.description,
		icon: preset.icon,
		orientation: preset.orientation,
		root: preset.root,
	};
}

export class ParadisLayoutPresetEditorInput extends EditorInput implements IEditorCloseHandler {

	static readonly ID = PARADIS_LAYOUT_PRESET_INPUT_TYPE_ID;

	private readonly _onDidChangeDraft = this._register(new Emitter<void>());
	/** 下書きが差し替わったとき（EditorPane が描き直すために購読する）。 */
	readonly onDidChangeDraft: Event<void> = this._onDidChangeDraft.event;

	private _draft: IParadisLayoutPresetDefinition;
	/** 保存済みの中身の指紋。下書きがこれと違えば dirty。 */
	private _savedFingerprint: string;
	/** 編集対象の既存プリセット。新規作成なら undefined。 */
	private _target: IParadisResolvedLayoutPreset | undefined;

	override readonly closeHandler: IEditorCloseHandler = this;

	readonly resource: URI;

	/**
	 * @param presetKey 編集する既存プリセットのキー。新規作成なら undefined。
	 *   キーで受けるのは、タブ復元（シリアライザ）が同じ経路を通れるようにするため。
	 */
	constructor(
		presetKey: string | undefined,
		@IParadisLayoutPresetService private readonly presetService: IParadisLayoutPresetService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super();
		this._target = presetKey ? this.presetService.presets.find(preset => preset.key === presetKey) : undefined;
		this._draft = this._target ? cloneDefinition(this._target) : paradisEmptyLayoutPreset();
		this._savedFingerprint = this._target ? paradisLayoutPresetFingerprint(this._target) : NEVER_SAVED;
		// 同じプリセットを2つのタブで開かないよう、リソースは編集対象ごとに一意にする
		// （新規は毎回別のタブとして開けてよい）。
		this.resource = URI.from({
			scheme: 'paradis-layout-preset',
			path: `/${presetKey ?? `new-${++newInputCounter}`}`,
		});
	}

	override get typeId(): string {
		return ParadisLayoutPresetEditorInput.ID;
	}

	override get editorId(): string {
		return PARADIS_LAYOUT_PRESET_EDITOR_ID;
	}

	override getName(): string {
		// allow-any-unicode-next-line
		return localize('paradis.layoutPresets.inputName', "レイアウト: {0}", this._draft.name);
	}

	override getIcon(): ThemeIcon {
		return Codicon.layout;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof ParadisLayoutPresetEditorInput && other.resource.toString() === this.resource.toString();
	}

	/** 編集中の中身（EditorPane から読む）。差し替えは {@link updateDraft} を通す。 */
	get draft(): IParadisLayoutPresetDefinition {
		return this._draft;
	}

	/** 編集対象の既存プリセット（新規なら undefined）。 */
	get target(): IParadisResolvedLayoutPreset | undefined {
		return this._target;
	}

	updateDraft(draft: IParadisLayoutPresetDefinition): void {
		this._draft = draft;
		this._onDidChangeDraft.fire();
		this._onDidChangeDirty.fire();
		this._onDidChangeLabel.fire();
	}

	override isDirty(): boolean {
		return paradisLayoutPresetFingerprint(this._draft) !== this._savedFingerprint;
	}

	override async save(): Promise<EditorInput | undefined> {
		const id = await this.presetService.savePreset(this._draft, this._target);
		// 保存した1件を **id で** 取り直して、以降の保存が同じ1件を置き換え続けるようにする。
		// 新規保存のあとに _target が undefined のままだと2回目の保存でもう1件増えるが、
		// ここを中身の照合で探すと、名前も形も同じ双子がいるときに他人の1件を掴んで
		// 以後ずっとそちらを上書きしてしまう。
		this._target = this.presetService.presets.find(preset => preset.id === id) ?? this._target;
		this._savedFingerprint = paradisLayoutPresetFingerprint(this._draft);
		this._onDidChangeDirty.fire();
		return this;
	}

	override async revert(): Promise<void> {
		this._savedFingerprint = this._target ? paradisLayoutPresetFingerprint(this._target) : NEVER_SAVED;
		this.updateDraft(this._target ? cloneDefinition(this._target) : paradisEmptyLayoutPreset());
	}

	// --- IEditorCloseHandler ---------------------------------------------------------------------

	showConfirm(): boolean {
		return this.isDirty();
	}

	async confirm(): Promise<ConfirmResult> {
		const { result } = await this.dialogService.prompt<ConfirmResult>({
			// allow-any-unicode-next-line
			message: localize('paradis.layoutPresets.confirmClose', "レイアウト「{0}」の変更を保存しますか？", this._draft.name),
			// allow-any-unicode-next-line
			detail: localize('paradis.layoutPresets.confirmCloseDetail', "保存しないと、組んだ枠の変更は失われます。"),
			buttons: [
				// allow-any-unicode-next-line
				{ label: localize('paradis.layoutPresets.confirmSave', "保存"), run: () => ConfirmResult.SAVE },
				// allow-any-unicode-next-line
				{ label: localize('paradis.layoutPresets.confirmDontSave', "保存しない"), run: () => ConfirmResult.DONT_SAVE },
			],
			cancelButton: { run: () => ConfirmResult.CANCEL },
		});
		return result ?? ConfirmResult.CANCEL;
	}
}

/**
 * ウィンドウ再起動後もタブを復元するシリアライザ。
 * 復元するのは「どのプリセットを編集していたか」だけで、未保存の下書きは復元しない
 * （下書きを設定の外に永続化すると、設定側で消えたプリセットの幽霊が残り続ける）。
 */
export class ParadisLayoutPresetEditorInputSerializer implements IEditorSerializer {

	// id を持つプリセットだけ復元対象にする。id が無い（手書きの）定義のキーは設定配列での
	// 位置由来なので、タブを開いたままリロードするあいだに並び替えや削除が起きると、
	// **別のプリセットの編集タブとして復元される**。
	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof ParadisLayoutPresetEditorInput && !!editorInput.target?.id;
	}

	serialize(editorInput: EditorInput): string | undefined {
		if (!(editorInput instanceof ParadisLayoutPresetEditorInput) || !editorInput.target?.id) {
			return undefined;
		}
		return JSON.stringify({ key: editorInput.target.key });
	}

	deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
		let key: unknown;
		try {
			key = JSON.parse(serializedEditorInput)?.key;
		} catch {
			return undefined;
		}
		if (typeof key !== 'string') {
			return undefined;
		}
		// 閉じている間に設定から消えたプリセットは復元しない（白紙のタブだけが残るのを防ぐ）。
		const exists = instantiationService.invokeFunction(accessor =>
			accessor.get(IParadisLayoutPresetService).presets.some(preset => preset.key === key));
		return exists ? instantiationService.createInstance(ParadisLayoutPresetEditorInput, key) : undefined;
	}
}
