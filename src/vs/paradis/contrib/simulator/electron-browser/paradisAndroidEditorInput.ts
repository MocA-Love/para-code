/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Android の端末のエディタのタブ（タブ 1 枚 = 端末 1 台。q.html Q585 の ⑥b）。resource は
// `paradis-simulator:/android/<serial>`。iOS のタブ（paradisSimulatorEditorInput.ts）と同じく、映す端末だけを持つ。

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { PARADIS_ANDROID_SERIAL_PREFIX, paradisAndroidSerialOf } from '../common/paradisAndroid.js';
import { PARADIS_SIMULATOR_SCHEME, paradisSimulatorTabName } from './paradisSimulatorEditorInput.js';

export const PARADIS_ANDROID_EDITOR_ID = 'paradis.editor.androidDevice';
export const PARADIS_ANDROID_INPUT_TYPE_ID = 'paradis.input.androidDevice';

export class ParadisAndroidEditorInput extends EditorInput {

	static readonly ID = PARADIS_ANDROID_INPUT_TYPE_ID;

	readonly resource: URI;
	private _assignedTerminals: readonly string[] = [];

	constructor(readonly serial: string, private _deviceName: string) {
		super();
		this.resource = URI.from({ scheme: PARADIS_SIMULATOR_SCHEME, path: `/android/${serial}` });
	}

	/** mobile_* のツールでの端末の id（台帳を引くため）。 */
	get deviceId(): string {
		return `${PARADIS_ANDROID_SERIAL_PREFIX}${this.serial}`;
	}

	get deviceName(): string {
		return this._deviceName;
	}

	setDeviceName(name: string): void {
		if (name && name !== this._deviceName) {
			this._deviceName = name;
			this._onDidChangeLabel.fire();
		}
	}

	setAssignedTerminals(names: readonly string[]): void {
		if (names.length === this._assignedTerminals.length && names.every((name, index) => name === this._assignedTerminals[index])) {
			return;
		}
		this._assignedTerminals = [...names];
		this._onDidChangeLabel.fire();
	}

	override get typeId(): string {
		return ParadisAndroidEditorInput.ID;
	}

	override get editorId(): string {
		return PARADIS_ANDROID_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return paradisSimulatorTabName(this._deviceName || localize('paradis.android.inputName', "Android"), this._assignedTerminals);
	}

	override getIcon(): ThemeIcon {
		return Codicon.deviceMobile;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || (other instanceof ParadisAndroidEditorInput && other.serial === this.serial);
	}
}

/** 復元のときに持つのは serial と名前だけ。 */
export class ParadisAndroidEditorInputSerializer implements IEditorSerializer {

	canSerialize(input: EditorInput): boolean {
		return input instanceof ParadisAndroidEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		return input instanceof ParadisAndroidEditorInput ? JSON.stringify({ serial: input.serial, name: input.deviceName }) : undefined;
	}

	deserialize(_instantiationService: unknown, serialized: string): EditorInput | undefined {
		try {
			const value = JSON.parse(serialized) as { serial?: unknown; name?: unknown };
			if (typeof value.serial !== 'string' || !paradisAndroidSerialOf(`${PARADIS_ANDROID_SERIAL_PREFIX}${value.serial}`)) {
				return undefined;
			}
			return new ParadisAndroidEditorInput(value.serial, typeof value.name === 'string' ? value.name : '');
		} catch {
			return undefined;
		}
	}
}
