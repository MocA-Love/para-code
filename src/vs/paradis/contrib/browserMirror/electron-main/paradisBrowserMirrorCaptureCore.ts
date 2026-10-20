/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { WebFrameMain } from 'electron';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';

export const PARADIS_MIRROR_CAPTURE_ENV = 'PARADIS_MIRROR_CAPTURE_VIEW';

interface IParadisMirrorCaptureWebContents {
	readonly mainFrame: WebFrameMain | null;
	isDestroyed(): boolean;
}

export interface IParadisMirrorCaptureHost {
	fromDevToolsTargetId(targetId: string): IParadisMirrorCaptureWebContents | undefined;
	getAllWebContents(): readonly IParadisMirrorCaptureWebContents[];
	isBrowserViewWebContents(webContents: IParadisMirrorCaptureWebContents): boolean;
}

/** 写しの予約 1 件。要求元のウィンドウと要求（offer のセッション）ごとに持つ。 */
interface IParadisMirrorCaptureArm {
	/** getDisplayMedia を呼ぶ workbench ウィンドウ。古い呼び出し元は付けない（どのウィンドウの要求にも当たる）。 */
	readonly windowId: number | undefined;
	/** 要求の識別子（offer のセッション）。同じウィンドウ・同じ要求の予約は上書きする。 */
	readonly requestId: string | undefined;
	readonly targetId: string;
	readonly armedAt: number;
	/** 同じウィンドウに予約が重なり、どの要求がどの予約のものか決められなくなった。 */
	conflicted: boolean;
}

export class ParadisBrowserMirrorCapture {

	private static readonly armTtl = 15_000;
	/**
	 * 最後の予約からこの間は、予約の無い getDisplayMedia を写しの要求とみなして断る。重なりで予約を
	 * 取られた要求や、期限で捨てた予約の要求が、画面全体の取得へ落ちてデスクトップ全体をスマホへ
	 * 送らないようにする（予約は期限の後もこの間だけ残し、来た要求に断りとして消費させる）。
	 */
	private static readonly guardWindow = ParadisBrowserMirrorCapture.armTtl * 2;

	private arms: IParadisMirrorCaptureArm[] = [];
	private lastArmedAt = Number.NEGATIVE_INFINITY;

	constructor(private readonly host: IParadisMirrorCaptureHost) { }

	/**
	 * 次の 1 回の getDisplayMedia を、指定した DevTools targetId のビュー単体の取得として予約する。
	 * `windowId` は getDisplayMedia を呼ぶ workbench ウィンドウ、`requestId` は要求の識別子。
	 */
	arm(targetId: string, windowId?: number, requestId?: string): void {
		const now = Date.now();
		this.purge(now);
		if (requestId !== undefined) {
			this.arms = this.arms.filter(arm => arm.windowId !== windowId || arm.requestId !== requestId);
		}
		this.arms.push({ windowId, requestId, targetId, armedAt: now, conflicted: false });
		this.lastArmedAt = now;
	}

	/** 写しの準備をやめた要求の予約を取り消す（offer を renderer へ渡さなかったとき）。 */
	disarm(windowId: number | undefined, requestId: string): void {
		this.arms = this.arms.filter(arm => arm.windowId !== windowId || arm.requestId !== requestId);
	}

	/**
	 * getDisplayMedia の要求に対して取得するフレームを返す。`'deny'` は断る（画面全体へは落とさない）、
	 * `undefined` は写しと無関係な要求（従来どおり画面全体の取得へ進む）。
	 *
	 * @param requesterWindowId 要求元のウィンドウ。分からなければ undefined。
	 */
	resolve(requesterWindowId?: number): WebFrameMain | 'deny' | undefined {
		const now = Date.now();
		this.purge(now);
		const mirrorActive = this.arms.length > 0 || now - this.lastArmedAt < ParadisBrowserMirrorCapture.guardWindow;
		const candidates = this.arms.filter(arm => arm.windowId === undefined || arm.windowId === requesterWindowId);

		if (candidates.length === 0) {
			if (mirrorActive) {
				// 写しの予約がある・あったばかりなのに、この要求に当たる予約が無い。取り違えか予約の取り合いで
				// 予約を失った写しの要求かもしれないので、画面全体へ落とさず断る。
				reportParadisDiagnosticError('owned', 'browser-mirror', 'resolve-denied', new Error('mirror capture request had no matching arm'), { safe_reason: 'no-arm' }, 'info');
				return 'deny';
			}
			return this.resolveFromEnvironment();
		}

		const [arm] = candidates;
		this.arms = this.arms.filter(candidate => candidate !== arm);
		if (candidates.length > 1) {
			// 同じウィンドウに予約が重なった。どの要求がどの予約のものか決められないので、重なった分の要求は
			// すべて断る（残りの予約は断りとして消費させる）。
			for (const candidate of candidates) {
				candidate.conflicted = true;
			}
		}
		if (arm.conflicted) {
			reportParadisDiagnosticError('owned', 'browser-mirror', 'resolve-denied', new Error('mirror capture arms conflicted'), { safe_reason: 'conflict' }, 'info');
			return 'deny';
		}
		if (now - arm.armedAt > ParadisBrowserMirrorCapture.armTtl) {
			// getDisplayMedia がフェイルクローズしても呼び出し側は無音で画面全体キャプチャの
			// フォールバックを打ち切るだけなので、ここで報告しないと再現しない不具合になる。
			reportParadisDiagnosticError('owned', 'browser-mirror', 'resolve-denied', new Error('mirror capture arm expired before getDisplayMedia'), { safe_reason: 'expired' }, 'info');
			return 'deny';
		}
		const webContents = this.host.fromDevToolsTargetId(arm.targetId);
		if (webContents && !webContents.isDestroyed() && webContents.mainFrame) {
			return webContents.mainFrame;
		}
		reportParadisDiagnosticError('owned', 'browser-mirror', 'resolve-denied', new Error('mirror capture target not found or destroyed'), { safe_reason: 'target-unavailable' }, 'info');
		return 'deny';
	}

	/** 期限を大きく過ぎた予約を捨てる（来なかった要求の予約を溜めない）。 */
	private purge(now: number): void {
		this.arms = this.arms.filter(arm => now - arm.armedAt <= ParadisBrowserMirrorCapture.guardWindow);
	}

	private resolveFromEnvironment(): WebFrameMain | undefined {
		if (!process.env[PARADIS_MIRROR_CAPTURE_ENV]) {
			return undefined;
		}

		for (const webContents of this.host.getAllWebContents()) {
			if (webContents.isDestroyed()) {
				continue;
			}
			if (this.host.isBrowserViewWebContents(webContents)) {
				return webContents.mainFrame ?? undefined;
			}
		}

		return undefined;
	}
}
