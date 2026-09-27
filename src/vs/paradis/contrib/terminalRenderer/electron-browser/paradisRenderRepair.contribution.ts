/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルの描画ずれ（文字の欠け・古いグリフ）の自動修復と記録（TM12）。
//
// いつ検査するか: そのターミナルが見えるようになったとき（スペースの切り替えから戻った等）と、
// そのターミナルにフォーカスが入ったとき（ウィンドウに戻ったとき・スリープから復帰したときも、
// 前にフォーカスのあった要素にフォーカスが戻るのでここに入る）。常時の監視はせず、ウィンドウに
// 戻るたびに見えている全ターミナルを読むこともしない（WebGL の画面を読み戻すのは重い）。
// 購読はターミナル単位なので、補助ウィンドウへ移したターミナルでもそのまま効く。
//
// 何をするか: WebGL の画面を抜き取り（判定は common/paradisRenderDesync.ts）、2回続けて同じ場所が
// 欠けていれば、WebGL レンダラを作り直す（`recreateRendererAfterWindowChange`。ウィンドウを
// 移したときの古いグリフ対策として fork が xtermTerminal.ts に PARA-PATCH で足したもの）。
//
// 記録（既定オフ、設定 `paradis.terminal.renderRepair.recordScreen`）: 修復前後の画面の画像と、
// 欠けていたセルの場所（画面の文字は残さない）を、main プロセス経由で本人だけが読める権限
// （0600）でログのフォルダの `paradisTerminalRender/` へ書く。最大4件・7日で消える。
//
// 検出と記録の方式は Orca（stablyai/orca、MIT）の render-desync sentinel を移植した。

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ITerminalContribution, IXtermTerminal } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../../workbench/contrib/terminal/browser/terminalExtensions.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { IParadisTerminalPrivateFiles, PARADIS_TERMINAL_PRIVATE_FILES_CHANNEL } from '../../terminalPrivateFiles/common/paradisTerminalPrivateFiles.js';
import {
	IParadisRenderDivergence,
	IParadisRenderGrid,
	paradisIsSuspectDivergence,
	paradisIsThinGlyph,
	paradisIsUnmeasurableDivergence,
	paradisMeasureRenderDivergence,
	paradisMissingCellCoordinates,
	paradisMissingSetsOverlap,
	ParadisRenderDesyncGate,
} from '../common/paradisRenderDesync.js';

export const PARADIS_RENDER_REPAIR_ENABLED_SETTING = 'paradis.terminal.renderRepair.enabled';
export const PARADIS_RENDER_REPAIR_RECORD_SETTING = 'paradis.terminal.renderRepair.recordScreen';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_RENDER_REPAIR_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('paradis.terminal.renderRepair.enabled', "ターミナルの文字が欠けて描かれているのを見つけたら、自動で描き直します。ターミナルが見えるようになったときと、フォーカスが入ったとき（ウィンドウに戻ったとき・スリープから復帰したときを含む）に検査します（GPU 描画のときだけ）。"),
		},
		[PARADIS_RENDER_REPAIR_RECORD_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('paradis.terminal.renderRepair.recordScreen', "描き直したとき、その前後の画面の画像と、欠けていた場所をログのフォルダ（paradisTerminalRender）に記録します。不具合の調査用です。画像には画面に写っていた秘密情報も残ります。記録は本人だけが読める権限で書き、最大4件・7日で消えます。"),
		},
	},
});

/** きっかけから最初の抜き取りまでの待ち（表示直後の描画が落ち着くのを待つ）。 */
const INSPECT_DELAY = 500;
/** 1回目と2回目の抜き取りの間隔。 */
const CONFIRM_DELAY = 250;
/** 作り直してから、直ったかどうかを測るまでの待ち。 */
const AFTER_REPAIR_DELAY = 500;

/** 抜き取りに要る xterm の非公開の部分（プロパティ名は xterm / addon-webgl の配布物でも縮められていない）。 */
interface IXtermRenderInternals {
	readonly _core?: {
		readonly _renderService?: {
			readonly _isPaused?: boolean;
			readonly _renderer?: {
				readonly value?: {
					readonly _canvas?: HTMLCanvasElement;
					readonly _charAtlas?: object;
					readonly _themeService?: { readonly colors?: { readonly background?: { readonly rgba?: number } } };
					readonly dimensions?: { readonly device?: { readonly cell?: { readonly width?: number; readonly height?: number } } };
				};
			};
		};
	};
}

interface IParadisRenderSnapshot {
	readonly divergence: IParadisRenderDivergence;
	/** 画面の画像（PNG の base64）。記録するときだけ作る。 */
	readonly png: string | undefined;
	/** ビューポートに見えている文字。1回目と2回目で変わっていたら出力が流れているので判定しない。記録には残さない。 */
	readonly bufferText: string;
	readonly rows: number;
	readonly cols: number;
}

/** WebGL で描いている間だけ、抜き取りに要る値を返す（DOM レンダラや描画停止中は undefined）。 */
function readRenderTarget(raw: RawXtermTerminal): { canvas: HTMLCanvasElement; grid: IParadisRenderGrid } | undefined {
	try {
		const service = (raw as unknown as IXtermRenderInternals)._core?._renderService;
		const renderer = service?._renderer?.value;
		const cell = renderer?.dimensions?.device?.cell;
		const backgroundRgba = renderer?._themeService?.colors?.background?.rgba;
		if (service?._isPaused || !renderer?._canvas || !renderer._charAtlas || typeof backgroundRgba !== 'number'
			|| typeof cell?.width !== 'number' || typeof cell.height !== 'number' || cell.width <= 0 || cell.height <= 0) {
			return undefined;
		}
		const buffer = raw.buffer.active;
		return {
			canvas: renderer._canvas,
			grid: {
				rows: raw.rows,
				cols: raw.cols,
				cellWidth: cell.width,
				cellHeight: cell.height,
				// スクロールして過去を見ている間は、カーソル行はビューポートの外にある
				cursorRow: buffer.baseY === buffer.viewportY ? buffer.cursorY : -1,
				// xterm は色を RRGGBBAA の数値で持つ
				backgroundRgb: [backgroundRgba >>> 24, (backgroundRgba >>> 16) & 255, (backgroundRgba >>> 8) & 255],
			},
		};
	} catch {
		return undefined;
	}
}

function viewportText(raw: RawXtermTerminal): string {
	const buffer = raw.buffer.active;
	const lines: string[] = [];
	for (let row = 0; row < raw.rows; row++) {
		lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
	}
	return lines.join('\n');
}

/** WebGL の画面を1回抜き取る。取れなければ undefined。 */
function takeSnapshot(raw: RawXtermTerminal, withImage: boolean): IParadisRenderSnapshot | undefined {
	const target = readRenderTarget(raw);
	if (!target || !target.canvas.width || !target.canvas.height) {
		return undefined;
	}
	const { canvas, grid } = target;
	// 読み取り用の 2D キャンバスは使うたびに作って捨てる（数 MB の裏バッファを持ち続けないため）
	const readback = canvas.ownerDocument.createElement('canvas');
	try {
		readback.width = canvas.width;
		readback.height = canvas.height;
		const context = readback.getContext('2d', { willReadFrequently: true });
		if (!context) {
			return undefined;
		}
		// Chromium が表示した通りの画面を読む（読み取りのために描き直させると、ずれが消えてしまう）
		context.drawImage(canvas, 0, 0);
		const image = context.getImageData(0, 0, readback.width, readback.height);
		const buffer = raw.buffer.active;
		const divergence = paradisMeasureRenderDivergence(image, grid, (row, col) => {
			const cell = buffer.getLine(buffer.viewportY + row)?.getCell(col);
			if (!cell || cell.getWidth() === 0 || cell.isInvisible()) {
				return false;
			}
			const chars = cell.getChars();
			return chars !== '' && chars !== ' ' && !paradisIsThinGlyph(chars);
		});
		const dataUrl = withImage ? readback.toDataURL('image/png') : undefined;
		return {
			divergence,
			png: dataUrl?.slice(dataUrl.indexOf(',') + 1),
			bufferText: viewportText(raw),
			rows: grid.rows,
			cols: grid.cols,
		};
	} catch {
		return undefined;
	} finally {
		readback.width = 0;
		readback.height = 0;
	}
}

/** このウィンドウで「測れなかった」回数（trace ログ用）。 */
let paradisUnmeasurableCount = 0;

class ParadisRenderRepairContribution extends Disposable implements ITerminalContribution {

	static readonly ID = 'terminal.paradisRenderRepair';

	private _xterm: (IXtermTerminal & { raw: RawXtermTerminal }) | undefined;
	private readonly _gate = new ParadisRenderDesyncGate();
	/** 検査中（待ちを含む）か。重ねて始めない。 */
	private _inspecting = false;
	private _timer: ReturnType<typeof setTimeout> | undefined;
	private readonly _files: IParadisTerminalPrivateFiles;

	constructor(
		private readonly _ctx: ITerminalContributionContext,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._files = ProxyChannel.toService<IParadisTerminalPrivateFiles>(mainProcessService.getChannel(PARADIS_TERMINAL_PRIVATE_FILES_CHANNEL));
		this._register(toDisposable(() => this._clearTimer()));
		this._register(this._ctx.instance.onDidChangeVisibility(visible => {
			if (visible) {
				this._schedule('visible');
			}
		}));
		this._register(this._ctx.instance.onDidFocus(() => this._schedule('focus')));
	}

	xtermOpen(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		this._xterm = xterm;
	}

	private _clearTimer(): void {
		if (this._timer !== undefined) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
	}

	private _wait(delay: number): Promise<void> {
		return new Promise(resolve => {
			this._timer = setTimeout(() => {
				this._timer = undefined;
				resolve();
			}, delay);
		});
	}

	private _schedule(trigger: string): void {
		if (this._inspecting || !this._xterm || !this._gate.canInspect()
			|| !this._configurationService.getValue<boolean>(PARADIS_RENDER_REPAIR_ENABLED_SETTING)) {
			return;
		}
		this._inspecting = true;
		void this._inspect(trigger).finally(() => this._inspecting = false);
	}

	private _canSample(): boolean {
		return !this._store.isDisposed && this._ctx.instance.isVisible && !!this._xterm;
	}

	private async _inspect(trigger: string): Promise<void> {
		await this._wait(INSPECT_DELAY);
		const xterm = this._xterm;
		if (!xterm || !this._canSample()) {
			return;
		}
		const record = this._configurationService.getValue<boolean>(PARADIS_RENDER_REPAIR_RECORD_SETTING) === true;
		const first = takeSnapshot(xterm.raw, false);
		if (first && paradisIsUnmeasurableDivergence(first.divergence)) {
			// WebGL の描画バッファを読めていない（全部が欠けて見える）。判定はしないが、読み取りが
			// 効いているかを実機で確かめられるよう回数を残す
			paradisUnmeasurableCount++;
			this._logService.trace(`[ParadisRenderRepair] could not measure terminal ${this._ctx.instance.instanceId} (${first.divergence.missing}/${first.divergence.textCells} cells look empty, ${paradisUnmeasurableCount} times in this window)`);
			return;
		}
		if (!first || !paradisIsSuspectDivergence(first.divergence)) {
			return;
		}
		await this._wait(CONFIRM_DELAY);
		if (!this._canSample()) {
			return;
		}
		const second = takeSnapshot(xterm.raw, record);
		// 本物の欠けは同じセルに居座る。出力が流れている・描画が追いついていないだけなら、
		// 文字か欠けの位置のどちらかが動く。
		if (!second || !paradisIsSuspectDivergence(second.divergence) || second.bufferText !== first.bufferText
			|| !paradisMissingSetsOverlap(first.divergence.missingCells, second.divergence.missingCells)) {
			return;
		}

		const { textCells, missing, missPct } = second.divergence;
		this._logService.warn(`[ParadisRenderRepair] render desync on terminal ${this._ctx.instance.instanceId} (${missing}/${textCells} cells, ${missPct.toFixed(1)}%, ${trigger}); recreating the renderer`);
		xterm.recreateRendererAfterWindowChange();
		this._gate.noteRepaired();

		await this._wait(AFTER_REPAIR_DELAY);
		const after = this._canSample() ? takeSnapshot(xterm.raw, record) : undefined;
		const stillSuspect = after !== undefined && paradisIsSuspectDivergence(after.divergence);
		this._gate.noteAfterRepair(stillSuspect);
		if (stillSuspect) {
			this._logService.warn(`[ParadisRenderRepair] terminal ${this._ctx.instance.instanceId} still looks broken after the repair; treating it as a false positive and not inspecting it again`);
		}
		// 件数と割合だけ（画面の中身は送らない）
		reportParadisDiagnosticError('owned', 'terminal-renderer', 'render-desync-repaired', new Error('Terminal render desync repaired'), {
			trigger,
			text_cells: textCells,
			missing_cells: missing,
			missing_pct: Math.round(missPct * 10) / 10,
			healed: after !== undefined && !stillSuspect,
		}, 'info');

		if (record) {
			const info = {
				when: new Date().toISOString(),
				trigger,
				terminal: this._ctx.instance.instanceId,
				rows: second.rows,
				cols: second.cols,
				before: { textCells, missing, missPct },
				after: after ? { textCells: after.divergence.textCells, missing: after.divergence.missing, missPct: after.divergence.missPct } : undefined,
				healed: after !== undefined && !stillSuspect,
				// 画面の文字は残さず、欠けていたセルの場所（ビューポートの [行, 列]）だけを残す
				missingCells: paradisMissingCellCoordinates(second.divergence, second.cols),
			};
			try {
				const folder = await this._files.writeRenderEvidence({ beforePng: second.png, afterPng: after?.png, info: JSON.stringify(info, null, '\t') + '\n' });
				this._logService.info(`[ParadisRenderRepair] recorded the screen to ${folder}`);
			} catch (error) {
				this._logService.warn('[ParadisRenderRepair] could not record the screen', error);
			}
		}
	}
}

registerTerminalContribution(ParadisRenderRepairContribution.ID, ParadisRenderRepairContribution);
