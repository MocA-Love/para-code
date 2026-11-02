/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイル端末の接続（ペアリング）の QR を出す小さいモーダル（共通の S 段）。以前はエディタのタブ（webview）に
// 出していたが、ほかのタブの裏に回ると 5 分の期限に気付けないので、前面のモーダルにした。
// 見出しの帯・QR と 3 つの手順・下端の帯（残り時間とリンクのコピー）を本家の部品で書く。

import './media/paradisMobilePairingDialog.css';
import * as dom from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { toAction } from '../../../../base/common/actions.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ParadisModalSize, paradisModalClasses } from '../../../browser/paradisModal.js';

const $ = dom.$;

/** 残り時間の表示（`4:52`）。切れていれば undefined。 */
export function paradisPairingRemainingText(expiresAt: number, now: number): string | undefined {
	const seconds = Math.ceil((expiresAt - now) / 1000);
	if (seconds <= 0) {
		return undefined;
	}
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export class ParadisMobilePairingDialog extends Disposable {

	private readonly backdrop: HTMLElement;
	private readonly remaining: HTMLElement;
	private readonly copyButton: Button;
	private readonly copiedReset = this._register(new MutableDisposable());

	constructor(
		qrSvg: string,
		private readonly pairingUri: string,
		private readonly expiresAt: number,
		@ILayoutService layoutService: ILayoutService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super();
		// allow-any-unicode-next-line
		const title = localize('paradis.mobile.pairingTitle', "モバイルデバイスを接続");

		this.backdrop = $('.paradis-mobile-pairing-backdrop.paradis-modal-backdrop');
		const dialog = dom.append(this.backdrop, $('.paradis-mobile-pairing-dialog'));
		dialog.classList.add(...paradisModalClasses(ParadisModalSize.Small));
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.tabIndex = -1;

		const header = dom.append(dialog, $('.pmp-header'));
		const heading = dom.append(header, $('h3.pmp-title'));
		heading.textContent = title;
		heading.id = 'paradis-mobile-pairing-title';
		dialog.setAttribute('aria-labelledby', heading.id);
		const closeBar = this._register(new ActionBar(dom.append(header, $('.pmp-header-actions'))));
		// allow-any-unicode-next-line
		closeBar.push(toAction({ id: 'paradis.mobile.pairingClose', label: localize('paradis.mobile.pairingClose', "閉じる"), class: ThemeIcon.asClassName(Codicon.close), run: () => this.dispose() }), { icon: true, label: false });

		const body = dom.append(dialog, $('.pmp-body'));
		const qr = dom.append(body, $('img.pmp-qr')) as HTMLImageElement;
		qr.src = `data:image/svg+xml;base64,${btoa(qrSvg)}`;
		qr.alt = 'QR';
		const steps = dom.append(body, $('ol.pmp-steps'));
		for (const step of [
			// allow-any-unicode-next-line
			localize('paradis.mobile.pairingStep1', "Para Code Mobile で「QR を読み取る」を開く"),
			// allow-any-unicode-next-line
			localize('paradis.mobile.pairingStep2', "この QR を読み取る"),
			// allow-any-unicode-next-line
			localize('paradis.mobile.pairingStep3', "両方に出る 6 桁のコードが同じか確かめて承認する"),
		]) {
			dom.append(steps, $('li')).textContent = step;
		}

		const footer = dom.append(dialog, $('.pmp-footer'));
		this.remaining = dom.append(footer, $('span.pmp-remaining'));
		this.remaining.setAttribute('aria-live', 'off');
		dom.append(footer, $('span.pmp-spacer'));
		this.copyButton = this._register(new Button(footer, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.setCopyLabel(false);
		this._register(this.copyButton.onDidClick(() => void this.copyLink()));

		this._register(dom.addDisposableListener(this.backdrop, 'mousedown', e => {
			if (e.target === this.backdrop) {
				this.dispose();
			}
		}));
		this._register(dom.addDisposableListener(this.backdrop, 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				this.dispose();
			}
		}));

		const timer = this._register(new IntervalTimer());
		timer.cancelAndSet(() => this.updateRemaining(), 1000, dom.getWindow(layoutService.activeContainer));
		this.updateRemaining();

		layoutService.activeContainer.appendChild(this.backdrop);
		this._register(toDisposable(() => this.backdrop.remove()));
		dialog.focus();
	}

	private updateRemaining(): void {
		const text = paradisPairingRemainingText(this.expiresAt, Date.now());
		this.remaining.classList.toggle('expired', text === undefined);
		this.remaining.textContent = text !== undefined
			// allow-any-unicode-next-line
			? localize('paradis.mobile.pairingRemaining', "あと {0} 有効", text)
			// allow-any-unicode-next-line
			: localize('paradis.mobile.pairingExpired', "期限が切れました。もう一度「モバイルデバイスを接続」を開いてください");
	}

	private setCopyLabel(copied: boolean): void {
		this.copyButton.label = copied
			// allow-any-unicode-next-line
			? `$(check) ${localize('paradis.mobile.pairingCopied', "コピーしました")}`
			// allow-any-unicode-next-line
			: `$(copy) ${localize('paradis.mobile.pairingCopy', "リンクをコピー")}`;
	}

	private async copyLink(): Promise<void> {
		await this.clipboardService.writeText(this.pairingUri);
		if (this._store.isDisposed) {
			return;
		}
		this.setCopyLabel(true);
		const handle = setTimeout(() => this.setCopyLabel(false), 2000);
		this.copiedReset.value = toDisposable(() => clearTimeout(handle));
	}
}
