// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Alert, Platform } from 'react-native';
import { hapticSelection } from './haptics.js';

/**
 * 「ターミナル名を変える」の入口。**器はOSの標準アラートに任せる。**
 *
 * 以前はまったく同じ処理（`renameTerminal`）を2つの自作ダイアログから呼んでいた:
 *  - エージェント情報シートの中身を差し替える方式（ラベル＋枠付き入力＋キャンセル/保存）
 *  - ホーム長押しメニューのガラスのアラート風パネル（キャンセル/変更）
 * さらに設定のPC名だけが `Alert.prompt`（＝OSのもの）で、同じ「1行の名前を変える」が
 * 3通りの見た目・ボタン配置・確定の作法を持っていた。ここへ寄せると自作2つが丸ごと消え、
 * 文言・上限・trimの規則も1箇所になる。
 *
 * `Alert.prompt` はiOS専用（Androidには存在せず、呼ぶと TypeError になる）。配信先は
 * iPhone/iPadなので今はこれで足りるが、Androidに出す日が来たらここだけ分岐すればよい
 * ——呼び出し側は増やさない。
 */

/** 入力の上限。PC側のタブ名へそのまま流れるため、常識的な長さで止める。 */
const TERMINAL_NAME_MAX_LENGTH = 120;

export function promptTerminalName(current: string, onSubmit: (name: string) => void): void {
	hapticSelection();
	if (Platform.OS !== 'ios') {
		// 自作ダイアログを復活させるより、できないことを言うほうが混乱が少ない。
		Alert.alert('ターミナル名', 'この端末では名前を変更できません。');
		return;
	}
	Alert.prompt(
		'ターミナル名',
		'PCのターミナルタブ名にも反映されます',
		[
			{ text: 'キャンセル', style: 'cancel' },
			{
				text: '変更', onPress: (value?: string) => {
					// `Alert.prompt` に maxLength は無いので、確定側で詰める。
					const next = (value ?? '').trim().slice(0, TERMINAL_NAME_MAX_LENGTH);
					if (next.length > 0 && next !== current) {
						onSubmit(next);
					}
				},
			},
		],
		'plain-text',
		current,
	);
}
