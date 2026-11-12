/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイル端末の接続（ペアリング）の QR を出す小さいモーダル（共通の S 段）。以前はエディタのタブ（webview）に
// 出していたが、ほかのタブの裏に回ると 5 分の期限に気付けないので、前面のモーダルにした。
// 見出しの帯（キットの帯）・QR と 3 つの手順・下端の帯（残り時間とリンクのコピー）。期限が切れたら QR を薄くして
// コピーを止め、QR の所の「新しい QR を作る」でその場でやり直せるようにする。

import './media/paradisMobilePairingDialog.css';
import * as dom from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { paradisButtonClasses } from '../../../browser/paradisButton.js';
import { ParadisModalSize, paradisModalClasses, renderParadisModalHead } from '../../../browser/paradisModal.js';
import { ParadisModalFocus } from '../../paradisSettings/browser/paradisModalFocus.js';

const $ = dom.$;

/** 残り時間の表示（`4:52`）。切れていれば undefined。 */
export function paradisPairingRemainingText(expiresAt: number, now: number): string | undefined {
	const seconds = Math.ceil((expiresAt - now) / 1000);
	if (seconds <= 0) {
		return undefined;
	}
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * ペアリングの小窓が閉じたときに待ち受けを取り消すかを決める。成立・失敗した後（呼び出し側が小窓を閉じる）と、
 * 確認コードのダイアログが出ている間（その答えで承認・拒否する）は取り消さない。取り消すのは 1 回だけ。
 */
export class ParadisPairingCloseGuard {
	private settled = false;
	private confirming = 0;

	/** 成立・失敗した。 */
	settle(): void {
		this.settled = true;
	}

	beginConfirm(): void {
		this.confirming++;
	}

	endConfirm(): void {
		this.confirming = Math.max(0, this.confirming - 1);
	}

	/** 小窓が閉じた。取り消すなら true（以後は false）。 */
	shouldCancelOnClose(): boolean {
		if (this.settled || this.confirming > 0) {
			return false;
		}
		this.settled = true;
		return true;
	}
}

export class ParadisMobilePairingDialog extends Disposable {

	private readonly backdrop: HTMLElement;
	private readonly remaining: HTMLElement;
	private readonly qr: HTMLImageElement;
	private readonly expiredCover: HTMLElement;
	private readonly copyButton: Button;
	private readonly regenerateButton: Button;
	private readonly timer = this._register(new IntervalTimer());
	private expired = false;
	private readonly copiedReset = this._register(new MutableDisposable());
	/** 閉じた（閉じるボタン・外側の押下・Esc・別のモーダル・呼び出し側の dispose のどれでも）ときに 1 回だけ知らせる。 */
	private readonly _onDidClose = new Emitter<void>();
	readonly onDidClose = this._onDidClose.event;
	/** 期限が切れた後に「新しい QR を作る」が押された。小窓は閉じない（待ち受けを取り消してから呼び出し側が閉じる）。 */
	private readonly _onDidRequestNewCode = this._register(new Emitter<void>());
	readonly onDidRequestNewCode = this._onDidRequestNewCode.event;

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

		// 見出しの帯はほかの S 段のモーダルと同じキットの帯（高さ 52・下線・28 の閉じる）
		const head = renderParadisModalHead(dialog, title);
		head.title.id = 'paradis-mobile-pairing-title';
		dialog.setAttribute('aria-labelledby', head.title.id);
		// allow-any-unicode-next-line
		const closeLabel = localize('paradis.mobile.pairingClose', "閉じる");
		// アイコンは中の span に置く（ボタンの要素に codicon を付けると、キットのボタンの font-family が字形を消す）
		const close = dom.append(head.actions, $<HTMLButtonElement>('button'));
		close.type = 'button';
		close.classList.add(...paradisButtonClasses('icon'));
		close.title = closeLabel;
		close.setAttribute('aria-label', closeLabel);
		dom.append(close, $(ThemeIcon.asCSSSelector(Codicon.close)));
		this._register(dom.addDisposableListener(close, dom.EventType.CLICK, () => this.dispose()));

		const body = dom.append(dialog, $('.pmp-body'));
		const qrWrap = dom.append(body, $('.pmp-qr-wrap'));
		this.qr = dom.append(qrWrap, $<HTMLImageElement>('img.pmp-qr'));
		this.qr.src = `data:image/svg+xml;base64,${btoa(qrSvg)}`;
		// allow-any-unicode-next-line
		this.qr.alt = localize('paradis.mobile.pairingQrAlt', "Para Code Mobile で読み取るペアリング用の QR コード");
		// 期限が切れたら QR の上に重ねる（切れる前は出さず、Tab の順にも入れない）
		this.expiredCover = dom.append(qrWrap, $('.pmp-qr-expired'));
		// allow-any-unicode-next-line
		dom.append(this.expiredCover, $('span.pmp-qr-expired-title')).textContent = localize('paradis.mobile.pairingExpiredTitle', "期限が切れました");
		// allow-any-unicode-next-line
		dom.append(this.expiredCover, $('span.pmp-qr-expired-detail')).textContent = localize('paradis.mobile.pairingExpiredDetail', "この QR はもう使えません");
		this.regenerateButton = this._register(new Button(this.expiredCover, { ...defaultButtonStyles, supportIcons: true }));
		// allow-any-unicode-next-line
		this.regenerateButton.label = `$(refresh) ${localize('paradis.mobile.pairingRegenerate', "新しい QR を作る")}`;
		this._register(this.regenerateButton.onDidClick(() => this._onDidRequestNewCode.fire()));
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

		this.timer.cancelAndSet(() => this.updateRemaining(), 1000, dom.getWindow(layoutService.activeContainer));

		layoutService.activeContainer.appendChild(this.backdrop);
		this._register(toDisposable(() => this.backdrop.remove()));
		// ほかの Para Code のモーダルと同じ決まりに乗せる（Esc で閉じる・閉じたら前のフォーカスへ戻す・後から別のモーダルを
		// 開いたら閉じる）。乗せないと Hub などを開いたときに裏に隠れたまま、期限だけが進む。
		this._register(new ParadisModalFocus({
			backdrop: this.backdrop,
			modal: dialog,
			onEscape: () => this.dispose(),
			close: () => this.dispose(),
		}));
		// 開いたら最初に押せる物（期限の前はリンクのコピー、切れていれば「新しい QR を作る」）へフォーカスを移す
		this.updateRemaining();
		if (!this.expired) {
			this.copyButton.focus();
		}
	}

	override dispose(): void {
		if (this._store.isDisposed) {
			return;
		}
		super.dispose();
		this._onDidClose.fire();
		this._onDidClose.dispose();
	}

	private updateRemaining(): void {
		if (this.expired) {
			return;
		}
		const text = paradisPairingRemainingText(this.expiresAt, Date.now());
		if (text !== undefined) {
			// allow-any-unicode-next-line
			this.remaining.textContent = localize('paradis.mobile.pairingRemaining', "あと {0} 有効", text);
			return;
		}
		// 期限が切れた: 数えるのを止め、切れた QR とリンクを使えなくして、その場でやり直せるボタンを出す
		this.expired = true;
		this.timer.cancel();
		this.copiedReset.clear();
		// allow-any-unicode-next-line
		const expired = localize('paradis.mobile.pairingExpired', "期限が切れました");
		this.remaining.classList.add('expired');
		this.remaining.textContent = expired;
		this.qr.classList.add('expired');
		this.expiredCover.classList.add('shown');
		this.setCopyLabel(false);
		this.copyButton.enabled = false;
		// 押せなくしたボタンにフォーカスが残ると箱の外へ落ちて Esc が効かなくなるので、やり直しのボタンへ移す
		this.regenerateButton.focus();
		// 残り時間の欄は毎秒変わるので読み上げない（aria-live='off'）。切れたことだけ 1 回伝える
		status(expired);
	}

	private setCopyLabel(copied: boolean): void {
		this.copyButton.label = copied
			// allow-any-unicode-next-line
			? `$(check) ${localize('paradis.mobile.pairingCopied', "コピーしました")}`
			// allow-any-unicode-next-line
			: `$(copy) ${localize('paradis.mobile.pairingCopy', "リンクをコピー")}`;
	}

	private async copyLink(): Promise<void> {
		if (this.expired) {
			return;
		}
		await this.clipboardService.writeText(this.pairingUri);
		if (this._store.isDisposed || this.expired) {
			return;
		}
		this.setCopyLabel(true);
		const handle = setTimeout(() => this.setCopyLabel(false), 2000);
		this.copiedReset.value = toDisposable(() => clearTimeout(handle));
	}
}
