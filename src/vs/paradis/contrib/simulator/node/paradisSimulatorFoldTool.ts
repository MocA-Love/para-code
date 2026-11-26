/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// MCP のツール mobile_fold（q.html Q582 の 4・Q585 の D5）。そのペインに割り当てた iPhone Duo を、姿勢の名前か
// 角度で開閉する。
//
//  - 端末は、必ず台帳からそのペインの割り当てを引く（ほかのペインの端末は触れない。#801 の LOW3）。任意の引数 `device` は、
//    そのペインに割り当てた端末の中から選ぶだけ（省いたら最後に割り当てた端末。simulator/common/paradisMobileAttachmentBook.ts）
//  - 画面の操作の側（mobile_rotate と同じ）なので、接続元の確認は掛けずトークンだけで動く。SSH の接続先のペインからも使える
//  - iOS のシミュレータを使えない（macOS でない）ときは一覧に出さない
//  - serve-sim の開閉は Device Hub が起動していないと断られる（Xcode 27.2 の Mac で実測）。断られたらその旨を返す

import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisMcpToolDefinition, IParadisMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { IParadisMobileDeviceLedger } from '../node/paradisSimulatorDeviceOps.js';
import { IParadisMobileAttachment } from '../common/paradisMobileCanvas.js';
import { IParadisMobileToolResult, paradisStampMobileDevice, paradisWithMobileDeviceArgument } from '../common/paradisMobileAttachmentBook.js';
import { ParadisSimulatorFold } from '../common/paradisSimulator.js';
import { paradisParseSimulatorFold } from '../common/paradisSimulatorFrames.js';
import { paradisSimulatorIsFoldable } from '../common/paradisSimulatorInput.js';
import { ParadisServeSimBackend } from './paradisServeSimBackend.js';
import { ParadisSimulatorDeviceHub } from './paradisSimulatorDeviceHub.js';
import { ParadisServeSimDeviceHost, paradisServeSimActiveDisplay, paradisServeSimUdidOf } from './paradisServeSimDeviceHost.js';

export const PARADIS_SIMULATOR_FOLD_TOOL: IParadisMcpToolDefinition = paradisWithMobileDeviceArgument({
	name: 'mobile_fold',
	description: 'Fold or unfold the foldable iOS simulator (iPhone Duo) attached to this terminal pane. Pass either pose ("closed" 0 degrees shows the cover screen, "book" 130 degrees, "open" 180 degrees is flat) or angle in degrees, not both. Returns the hinge angle, which screen is showing (cover or inner) and its size in points: every coordinate you pass to input tools afterwards must use this size. Device Hub (in Xcode) must be running for folding to work.',
	inputSchema: {
		type: 'object',
		properties: {
			pose: { type: 'string', enum: ['closed', 'book', 'open'] },
			angle: { type: 'number', description: 'Hinge angle in degrees, 0 (closed) to 180 (flat open).' },
		},
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
});

type IToolResult = IParadisMobileToolResult;

function errorResult(text: string): IToolResult {
	return { content: [{ type: 'text', text }], isError: true };
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class ParadisSimulatorFoldToolProvider implements IParadisMcpToolProvider {
	readonly cliGroup = 'mobile';

	constructor(
		private readonly _ledger: Pick<IParadisMobileDeviceLedger, 'resolveTarget'>,
		private readonly _backend: Pick<ParadisServeSimBackend, 'getScreenConfig' | 'fold' | 'listDevices'>,
		private readonly _host: Pick<ParadisServeSimDeviceHost, 'request' | 'forgetDisplay'>,
		/** 開閉で画面の大きさが変わったので、ツールが覚えた大きさを捨てる。 */
		private readonly _forgetScreenSize: (deviceId: string) => void,
		private readonly _isEnabled: () => boolean,
		private readonly _logService: ILogService | undefined,
		private readonly _deviceHub?: Pick<ParadisSimulatorDeviceHub, 'isRunning'>,
	) { }

	listTools(): readonly IParadisMcpToolDefinition[] {
		return this._isEnabled() ? [PARADIS_SIMULATOR_FOLD_TOOL] : [];
	}

	async callTool(paneToken: string, name: string, args: unknown): Promise<unknown | undefined> {
		if (name !== PARADIS_SIMULATOR_FOLD_TOOL.name) {
			return undefined;
		}
		if (!this._isEnabled()) {
			return errorResult('mobile_fold needs the new iOS simulator in Para Code, which is turned off.');
		}
		try {
			const record = args && typeof args === 'object' ? args as Record<string, unknown> : {};
			// 返事には、成功でも失敗でも、操作した端末の名前と id を入れる
			const target = await this._ledger.resolveTarget(paneToken, record.device);
			try {
				return paradisStampMobileDevice(await this._fold(target.attachment, record), target);
			} catch (error) {
				return paradisStampMobileDevice(errorResult(message(error)), target);
			}
		} catch (error) {
			return errorResult(message(error));
		}
	}

	private async _fold(attachment: IParadisMobileAttachment, record: Record<string, unknown>): Promise<IToolResult> {
		let fold: ParadisSimulatorFold;
		try {
			fold = paradisParseSimulatorFold({ pose: record.pose, hinge: record.angle });
		} catch {
			return errorResult('Pass exactly one of "pose" (closed, book or open) or "angle" (0 to 180 degrees).');
		}
		const udid = paradisServeSimUdidOf(attachment.deviceId);
		if (!udid) {
			return errorResult(`${attachment.deviceName} is not an iOS simulator, so it cannot be folded.`);
		}
		// 折りたたみかどうかは端末の型で見る（開き具合は、Xcode 27.2 では 1 度開閉するまで読めない）
		const before = await this._backend.getScreenConfig(udid);
		const device = (await this._backend.listDevices().catch(() => [])).find(candidate => candidate.udid === udid);
		if (!paradisSimulatorIsFoldable(device, before)) {
			return errorResult(`${attachment.deviceName} is not a foldable device (only the iPhone Duo simulator folds).`);
		}
		const accepted = await this._backend.fold(udid, fold);
		if (!accepted) {
			// 開閉は Device Hub が起動していないと断られる（Xcode 27.2 で実測）。エージェントからは起動しない
			const running = await this._deviceHub?.isRunning().catch(() => undefined);
			return errorResult(running === false
				? 'Device Hub is not running, and folding needs it. Ask the user to start it: the "Start Device Hub" button in the simulator tab of Para Code, or Xcode > Open Developer Tool > Device Hub. Then try again.'
				: 'The simulator did not accept the fold. Device Hub (Xcode > Open Developer Tool > Device Hub) must be running; ask the user to open it (the simulator tab of Para Code has a button), then try again.');
		}
		this._host.forgetDisplay(attachment.deviceId);
		this._forgetScreenSize(attachment.deviceId);
		const after = await this._backend.getScreenConfig(udid);
		const display = await this._host.request('GET', `/api/v1/devices/${encodeURIComponent(attachment.deviceId)}/display`, undefined).catch(() => undefined) as { pointWidth?: number; pointHeight?: number; scale?: number } | undefined;
		const activeDisplay = paradisServeSimActiveDisplay(after) ?? null;
		const expected = after.hingeDegrees === undefined ? undefined : after.hingeDegrees < 90 ? 'cover' : 'inner';
		const result = {
			hingeDegrees: after.hingeDegrees ?? null,
			activeDisplay,
			screen: display?.pointWidth ? { pointWidth: display.pointWidth, pointHeight: display.pointHeight, scale: display.scale } : null,
			// iOS 27.2 では閉じても内の画面のまま映ることがある（Mac で実測）。映っている画面は映像の大きさで決めている
			...(expected && activeDisplay && expected !== activeDisplay ? { note: `The hinge moved, but the simulator still shows the ${activeDisplay} screen. Coordinates follow the screen that is showing.` } : {}),
		};
		this._logService?.info(`[paradis-simulator] folded a simulator to ${fold.kind === 'pose' ? fold.pose : `${fold.hinge} degrees`}`);
		return { content: [{ type: 'text', text: JSON.stringify(result, undefined, 2) }], structuredContent: result };
	}
}
