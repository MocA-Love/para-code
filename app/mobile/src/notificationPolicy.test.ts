// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { decodeNotify, encodeNotify, type NotifyPayload } from '@para/protocol';
import { NOTIFY_BANNER_MAX_AGE_MS, shouldPresentNotifyBanner, type NotifyBannerContext } from './notificationPolicy.js';

const NOW = 1_700_000_000_000;

/**
 * 実際のバイト列を通してから判定する。手で組み立てたオブジェクトを渡すと、
 * コーデックが落とすフィールド（`quiet` の値の綴りを変えた等）に気づけない。
 */
function payload(overrides: Partial<NotifyPayload> = {}): NotifyPayload {
	return decodeNotify(encodeNotify({ kind: 'agent-question', id: 'n1', title: 't', body: 'b', terminalKey: 'term-1', at: NOW - 1_000, ...overrides }));
}

/** 既定は「アプリを前面で開いていて、別の画面を見ている」状態。 */
function context(overrides: Partial<NotifyBannerContext> = {}): NotifyBannerContext {
	return {
		appState: 'active',
		prefs: { agentDone: true, agentQuestion: true },
		viewingTerminalKey: undefined,
		pushRegistered: true,
		now: NOW,
		...overrides,
	};
}

describe('shouldPresentNotifyBanner', () => {
	it('前面で別の画面を見ているときは出す', () => {
		expect(shouldPresentNotifyBanner(payload(), context())).toBe(true);
	});

	// PC側が「鳴らす必要が無い」と判断した通知（種別オフ・PC操作中）。必ず従う。
	// これが二重通知の防止線で、時計に依存しないのが以前の鮮度チェックとの違い。
	it('mutedは必ず従う', () => {
		expect(shouldPresentNotifyBanner(payload({ quiet: 'muted' }), context())).toBe(false);
		expect(shouldPresentNotifyBanner(payload({ quiet: 'muted' }), context({ pushRegistered: false }))).toBe(false);
	});

	it('pushedはプッシュが届く端末では鳴らさない', () => {
		expect(shouldPresentNotifyBanner(payload({ quiet: 'pushed' }), context())).toBe(false);
	});

	// PCはプッシュの成否を知らない。プッシュを受け取れない端末（シミュレータ、通知許可なし）が
	// そのまま従うと、誰も気づけないまま通知が消える。
	it('pushedでもプッシュを受け取れない端末は自分で鳴らす', () => {
		expect(shouldPresentNotifyBanner(payload({ quiet: 'pushed' }), context({ pushRegistered: false }))).toBe(true);
	});

	it('プッシュ登録が未判定のうちは二重に鳴らさない側へ倒す', () => {
		expect(shouldPresentNotifyBanner(payload({ quiet: 'pushed' }), context({ pushRegistered: undefined }))).toBe(false);
	});

	it('バックグラウンド中は出さない（プッシュの担当）', () => {
		expect(shouldPresentNotifyBanner(payload(), context({ appState: 'background' }))).toBe(false);
	});

	// 通知センターを引き下げた等の短い中断ではソケットを維持するので、ここは自分で出す。
	it('inactiveでは出す', () => {
		expect(shouldPresentNotifyBanner(payload(), context({ appState: 'inactive' }))).toBe(true);
	});

	it('そのエージェントの画面を開いている間は出さない', () => {
		expect(shouldPresentNotifyBanner(payload(), context({ viewingTerminalKey: 'term-1' }))).toBe(false);
	});

	it('別のエージェントの画面を開いているだけなら出す', () => {
		expect(shouldPresentNotifyBanner(payload(), context({ viewingTerminalKey: 'term-2' }))).toBe(true);
	});

	// 席を外している前提が崩れる知らせなので、PC側の線引きと揃えて画面抑制の対象外にする。
	it('その画面を開いていてもエラー・切断は出す', () => {
		for (const kind of ['agent-error', 'disconnected'] as const) {
			expect(shouldPresentNotifyBanner(payload({ kind }), context({ viewingTerminalKey: 'term-1' }))).toBe(true);
		}
	});

	// ターミナルキーを持たない通知が、画面を開いているだけで消えてしまわないこと。
	it('ターミナルキーの無い通知は画面の状態に関係なく出す', () => {
		expect(shouldPresentNotifyBanner(payload({ terminalKey: undefined }), context({ viewingTerminalKey: 'term-1' }))).toBe(true);
	});

	it('quietを知らない旧PC向けに種別オフの保険が残っている', () => {
		expect(shouldPresentNotifyBanner(payload({ kind: 'agent-done' }), context({ prefs: { agentDone: false, agentQuestion: true } }))).toBe(false);
		expect(shouldPresentNotifyBanner(payload(), context({ prefs: { agentDone: true, agentQuestion: false } }))).toBe(false);
	});

	it('古すぎる通知は出さない', () => {
		expect(shouldPresentNotifyBanner(payload({ at: NOW - NOTIFY_BANNER_MAX_AGE_MS }), context())).toBe(true);
		expect(shouldPresentNotifyBanner(payload({ at: NOW - NOTIFY_BANNER_MAX_AGE_MS - 1 }), context())).toBe(false);
	});

	// PCの時計が進んでいると未来の時刻で届く。落とさないこと（以前の60秒窓では
	// 数分のずれで新しい通知まで消えていた）。
	it('PCの時計が進んでいても落とさない', () => {
		expect(shouldPresentNotifyBanner(payload({ at: NOW + 5 * 60_000 }), context())).toBe(true);
	});

	// 遅れ側は落とす。30分もずれている時計を新鮮とみなすと、復帰時に大昔の通知が鳴る。
	it('PCの時計が大きく遅れている分は落とす（仕様）', () => {
		expect(shouldPresentNotifyBanner(payload({ at: NOW - 40 * 60_000 }), context())).toBe(false);
	});
});
