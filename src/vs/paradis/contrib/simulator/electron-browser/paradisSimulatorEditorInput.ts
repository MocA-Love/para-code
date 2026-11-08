/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// シミュレータのエディタのタブ（タブ 1 枚 = 端末 1 台）。resource は `paradis-simulator:/<udid>`。
// タブは「どの端末を映すか」だけを持ち、「どのペインが操作してよいか」は持たない（それは shared process の台帳）。
// 同じ窓で同じ端末のタブは 1 枚にする（開き直しは前に出すだけ）。

import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IParadisMobileAttachment } from '../common/paradisMobileCanvas.js';
import { PARADIS_SIMULATOR_DEVICE_ID_PREFIX, paradisIsSimulatorUdid } from '../common/paradisSimulator.js';

export const PARADIS_SIMULATOR_EDITOR_ID = 'paradis.editor.simulator';
export const PARADIS_SIMULATOR_INPUT_TYPE_ID = 'paradis.input.simulator';
export const PARADIS_SIMULATOR_SCHEME = 'paradis-simulator';

export class ParadisSimulatorEditorInput extends EditorInput {

	static readonly ID = PARADIS_SIMULATOR_INPUT_TYPE_ID;

	readonly resource: URI;

	constructor(
		readonly udid: string,
		private _deviceName: string,
	) {
		super();
		this.resource = URI.from({ scheme: PARADIS_SIMULATOR_SCHEME, path: `/${udid}` });
	}

	get deviceName(): string {
		return this._deviceName;
	}

	private _assignedTerminals: readonly string[] = [];

	/** その端末を割り当てたターミナルの名前（タブの名前に添える。paradisSimulatorTabLabels.contribution.ts）。 */
	get assignedTerminals(): readonly string[] {
		return this._assignedTerminals;
	}

	setAssignedTerminals(names: readonly string[]): void {
		if (names.length === this._assignedTerminals.length && names.every((name, index) => name === this._assignedTerminals[index])) {
			return;
		}
		this._assignedTerminals = [...names];
		this._onDidChangeLabel.fire();
	}

	private _bootRequested = false;
	private readonly _onDidRequestBoot = this._register(new Emitter<void>());
	/** 開いた直後に、止まっていれば起動してほしい（エージェントの要求を承認したとき）。 */
	readonly onDidRequestBoot = this._onDidRequestBoot.event;

	requestBoot(): void {
		this._bootRequested = true;
		this._onDidRequestBoot.fire();
	}

	/** 起動の求めを受け取る（1 回だけ true）。 */
	takeBootRequest(): boolean {
		const requested = this._bootRequested;
		this._bootRequested = false;
		return requested;
	}

	/** 一覧から名前を読み直したとき（名前を変えた端末など）。 */
	setDeviceName(name: string): void {
		if (name && name !== this._deviceName) {
			this._deviceName = name;
			this._onDidChangeLabel.fire();
		}
	}

	override get typeId(): string {
		return ParadisSimulatorEditorInput.ID;
	}

	override get editorId(): string {
		return PARADIS_SIMULATOR_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return paradisSimulatorTabName(this._deviceName || localize('paradis.simulator.inputName', "シミュレータ"), this._assignedTerminals);
	}

	override getTitle(): string {
		return this._assignedTerminals.length
			? localize('paradis.simulator.inputTitleAssigned', "{0}（{1} が操作できます）", this._deviceName, this._assignedTerminals.join('、'))
			: this.getName();
	}

	override getIcon(): ThemeIcon {
		return Codicon.deviceMobile;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof ParadisSimulatorEditorInput && other.udid === this.udid;
	}
}

/** その端末（mobile_* のツールでの id）を割り当てたペインのターミナルの名前（台帳の順。名前が分からないペインは落とす）。 */
export function paradisDeviceAssignedTerminals(deviceId: string, attachments: readonly IParadisMobileAttachment[], terminalName: (paneToken: string) => string | undefined): string[] {
	return attachments.filter(attachment => attachment.deviceId === deviceId).map(attachment => terminalName(attachment.paneToken)).filter((name): name is string => !!name);
}

/** iOS のシミュレータ（udid）を割り当てたペインのターミナルの名前。 */
export function paradisSimulatorAssignedTerminals(udid: string, attachments: readonly IParadisMobileAttachment[], terminalName: (paneToken: string) => string | undefined): string[] {
	return paradisDeviceAssignedTerminals(`${PARADIS_SIMULATOR_DEVICE_ID_PREFIX}${udid}`, attachments, terminalName);
}

/** タブの名前: 端末の名前と、割り当てたターミナルの名前（無ければ端末の名前だけ）。 */
export function paradisSimulatorTabName(deviceName: string, terminals: readonly string[]): string {
	return terminals.length ? localize('paradis.simulator.tabName', "{0} · {1}", deviceName, terminals.join('、')) : deviceName;
}

interface ISerializedSimulatorInput {
	readonly udid: string;
	readonly name: string;
}

/** 復元のときに持つのは端末の udid と名前だけ。端末が落ちていてもタブは戻し、勝手に起動しない。 */
export class ParadisSimulatorEditorInputSerializer implements IEditorSerializer {

	canSerialize(input: EditorInput): boolean {
		return input instanceof ParadisSimulatorEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		if (!(input instanceof ParadisSimulatorEditorInput)) {
			return undefined;
		}
		const value: ISerializedSimulatorInput = { udid: input.udid, name: input.deviceName };
		return JSON.stringify(value);
	}

	deserialize(_instantiationService: unknown, serialized: string): EditorInput | undefined {
		try {
			const value = JSON.parse(serialized) as Partial<ISerializedSimulatorInput>;
			if (typeof value.udid !== 'string' || !paradisIsSimulatorUdid(value.udid)) {
				return undefined;
			}
			return new ParadisSimulatorEditorInput(value.udid, typeof value.name === 'string' ? value.name : '');
		} catch {
			return undefined;
		}
	}
}
