// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useIsFocused, useNavigation } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, mono, radius } from '../theme.js';
import { useParaHeaderStore, type ParaHeaderIcon } from '../paraHeader.js';

/**
 * OS標準のナビゲーションバーへ載せるバー項目の**中身**。
 *
 * **ガラスの器は置かない。** iOS 26 は `UIBarButtonItem` のカスタムビューへ自動でガラスの
 * 器を付け、隣り合う画像ボタンを1つの器へまとめる。ここで `GlassSurface` を重ねると
 * 器が二重になる（Apple Developer Forums 792159 に同じ症状の報告がある）。
 *
 * **なぜ自前のヘッダー層をやめてここへ来たのか。** 「島が丸い戻るボタンへ形ごと変わる」
 * 動きは iOS 26 の標準バーが push/pop のときに自分で描いている。Apple公式（
 * `UIBarButtonItem.identifier` の説明）が「バー項目の集合が変わると UIKit が自動で遷移を
 * アニメーションし、位置と内容から同じ項目を推定して対応付ける」と明言していて、
 * **識別子を与えなくても既定で走る**。実機で確認済み（2026-08-10）。
 *
 * 自前で再現しようとして3回壊した。しかも実測したガウスぼかしは公開APIでは作れない
 * （`GlassEffectTransition` の追加効果は scale と offset だけ）ので、自前は最初から
 * 「似ているが違う」に着地することが確定していた。**動きはOSに任せ、ここは中身だけを渡す。**
 *
 * 寸法の注意: iOS 26 はカスタムビューを**最低36pt幅まで引き伸ばす**
 * （`react-native-screens` の `RNSScreenStackHeaderSubview.mm` にその回避処理がある）。
 * 器の高さもバーが決めるので、ここでは高さを固定せず中身の寸法だけを決める。
 */

/** 左のバー項目。いまどのスペースのどのブランチを見ているか。 */
export function WsHeaderIsland({ name, sub, subColor, color, avatarText, avatarIcon, badge, label, onPress, disabled }: {
	readonly name: string;
	readonly sub?: string;
	readonly subColor?: string;
	readonly color: string;
	readonly avatarText?: string;
	readonly avatarIcon?: keyof typeof Ionicons.glyphMap;
	readonly badge: boolean;
	readonly label: string;
	readonly onPress?: () => void;
	readonly disabled: boolean;
}) {
	return (
		<Pressable
			style={styles.island}
			onPress={onPress}
			disabled={disabled || onPress === undefined}
			accessibilityRole={onPress === undefined ? undefined : 'button'}
			accessibilityLabel={label}
		>
			<View style={[styles.avatar, { backgroundColor: withAlpha(color) }]}>
				{avatarIcon !== undefined
					? <Ionicons name={avatarIcon} size={14} color={color} />
					: <Text style={[styles.avatarText, { color }]}>{avatarText ?? '—'}</Text>}
			</View>
			<View style={styles.islandText}>
				<Text style={styles.islandName} numberOfLines={1}>{name}</Text>
				{sub !== undefined && sub.length > 0
					? <Text style={[styles.islandSub, subColor !== undefined && { color: subColor }]} numberOfLines={1}>{sub}</Text>
					: null}
			</View>
			{badge ? <View style={styles.badge} /> : null}
		</Pressable>
	);
}

/**
 * 右のバー項目。**1つのビューにまとめて渡す**ので、OSはこれを1項目として扱い、
 * 全体に1つのガラスの器を付ける（いまの「アイコンが並んだピル」と同じ見た目になる）。
 */
export function WsHeaderActions({ items }: { readonly items: readonly ParaHeaderIcon[] }) {
	return (
		<View style={styles.actions}>
			{items.map(item => (
				<View key={item.key}>
					{item.node !== undefined ? item.node : (
						<Pressable
							style={styles.actionHit}
							hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
							onPress={item.onPress}
							accessibilityRole="button"
							accessibilityLabel={item.label}
						>
							<Ionicons name={item.icon ?? 'ellipse-outline'} size={item.size ?? 18} color={item.color ?? colors.text} />
							{item.badge === undefined ? null : (
								<View style={[styles.actionBadge, item.badge === 'red' ? styles.actionBadgeRed : styles.actionBadgeGreen]} />
							)}
						</Pressable>
					)}
				</View>
			))}
		</View>
	);
}

/**
 * バーの中央に出すタイトル（押すと情報シートが開く画面のためのもの）。
 *
 * 標準の `title` は文字列なので押せない。押せる必要がある画面だけこれを使う。
 * **中央に使える幅は `画面幅 − 2 × max(左, 右)`** なので、左が戻るボタンの丸・右が
 * ボタン1〜2個の画面（＝押し込んだ先）でしか成立しない。左に幅のある島が居るタブでは
 * 中央に置かないこと（実測で26ptしか残らず、文字が1文字まで削られた）。
 */
export function NativeHeaderTitle({ text, sub, subColor, chevron, label, onPress }: {
	readonly text: string;
	readonly sub?: string;
	readonly subColor?: string;
	readonly chevron: boolean;
	readonly label: string;
	readonly onPress?: () => void;
}) {
	return (
		<Pressable
			style={styles.title}
			onPress={onPress}
			disabled={onPress === undefined}
			accessibilityRole={onPress === undefined ? undefined : 'button'}
			accessibilityLabel={label}
		>
			<View style={styles.titleRow}>
				<Text style={styles.titleText} numberOfLines={1}>{text}</Text>
				{chevron ? <Ionicons name="chevron-down" size={12} color={colors.textDim} /> : null}
			</View>
			{sub !== undefined && sub.length > 0
				? <Text style={[styles.titleSub, subColor !== undefined && { color: subColor }]} numberOfLines={1}>{sub}</Text>
				: null}
		</Pressable>
	);
}

/**
 * 押し込んだ先の画面（エージェント詳細・ブラウザ・アーカイブ…）のヘッダー。
 *
 * **フックではなくコンポーネントで、`<Stack.Screen options>` として宣言する。**
 * `useEffect` の中で `setOptions` すると、**遷移が始まった後に**バー項目が作られることがあり、
 * UIKitは遷移の瞬間に前後のバー項目が揃っていないと対応付けできない——結果として
 * 「モーフする時としない時がある」になる（実機で確認済み）。描画時に宣言すれば間に合う。
 *
 * **接続ゲートの内側に置かないこと。** ゲートが閉じた瞬間にこれ自体がアンマウントされ、
 * 前の画面のバーが残る（`useWsHeader` が同じ理由でフックになっている）。伏せたいときは
 * `hidden` を渡す。
 *
 * **左は渡さない。** 戻るボタンはOSに任せる——タブ側の島がこの丸へ形ごと変わる動きは、
 * UIKitが「バー項目の集合が変わった」と見なして自分で描くものなので、自前の丸を置くと
 * その対応付けから外れる。文字のラベルは出さない（`minimal`）。
 */
export function NativeScreenHeader({ title, sub, subColor, chevron = false, label, onTitlePress, actions, hidden = false, translucent = false }: {
	readonly title: string;
	readonly sub?: string;
	readonly subColor?: string;
	readonly chevron?: boolean;
	readonly label?: string;
	readonly onTitlePress?: () => void;
	readonly actions?: readonly ParaHeaderIcon[];
	/** 接続ゲートが本文を塞いでいる間は伏せる（ゲート自身の戻ると二重に出るため）。 */
	readonly hidden?: boolean;
	/**
	 * バーを本文の上に浮かせ、下を流れる中身がブラー越しに透けるようにする。
	 *
	 * **モーフとは両立する**（あれはバー項目の遷移で、背景が透けるかどうかとは別物）。
	 * 既定を不透明にしているのは、何も指定しないとブラーの地色がiOS標準のダークグレー
	 * （#1c1c1e相当）になり、本文の #050506 との境目が帯として見えるため。ここでは地色に
	 * alpha を入れて自分で決める——`blurEffect` は「背景の alpha が 1 未満のときに効く」ので、
	 * 不透明のまま種類だけ指定しても何も起きない（ライブラリの型注釈にそう書いてある）。
	 *
	 * **渡す画面は本文の上余白を自分で持つこと。** 不透明のときはOSがバーの下から本文を
	 * 始めてくれるが、浮かせると本文はバーの背後（画面の最上端）から始まる。
	 */
	readonly translucent?: boolean;
}) {
	// 本文の上余白は要らない（OSがバーの下から本文を始める）。画面側は引き続き
	// `useParaHeaderHeight()` を読むので0を配る。
	useEffect(() => {
		useParaHeaderStore.getState().setHeight(0);
	}, []);

	// **描画関数と `options` は参照を安定させる。** 毎レンダー新しい関数を渡すとバー項目が
	// 作り直され、モーフの対象としての同一性まで切れる（タブ側の `useNativeWsHeader` が
	// 同じ理由で `useCallback` を挟んでいる）。この画面は情報シートの開閉やPCからの
	// state再送で何度も再レンダーされるので、素のインラインで書くと作り直しが常態化する。
	const headerTitle = useCallback(() => (
		<NativeHeaderTitle
			text={title}
			sub={sub}
			subColor={subColor}
			chevron={chevron}
			label={label ?? title}
			onPress={onTitlePress}
		/>
	), [title, sub, subColor, chevron, label, onTitlePress]);

	const headerRight = useCallback(() => (
		actions === undefined || actions.length === 0 ? null : <WsHeaderActions items={actions} />
	), [actions]);

	const options = useMemo(() => ({
		headerShown: !hidden,
		title: '',
		headerTitle,
		headerRight,
		// 戻るボタンはシェブロンだけにする。文字が付くと幅を食い、中央に使える幅が減る。
		headerBackButtonDisplayMode: 'minimal' as const,
		headerBackTitle: '',
		headerShadowVisible: false,
		// **半透明のときは地色を必ず `transparent` で上書きする。**
		// ブラーは `headerTransparent` と `headerBlurEffect` の組み合わせでOSが描くので、
		// 地色が塗られているとその上から潰れる（`rgba(5,5,6,0.55)` を敷いたら本文と同じ色が
		// 重なるだけで透けなかった）。そして**省略しても駄目**——`setOptions` はキーごとの
		// マージなので、親（`app/_layout.tsx`）が静的に置いた `headerStyle` の不透明な地色が
		// そのまま生き残る。実機で「透けない」が2度続いた原因はこれ（`blurEffect` は
		// 「背景の alpha が 1 未満のときに効く」ので、alpha 0 で明示するのが正しい）。
		...(translucent
			? {
				headerTransparent: true,
				// **ブラーは載せない。** 自前ヘッダー層がやっていたのはブラーではなく、
				// 背後を地色のグラデーションで落とすことだった（`headerEdgeFade.tsx`。上端で
				// 地色の94%、下端で完全に透明）。だから行が「奥へ入っていく」ように見えていた。
				// `blurEffect` を載せるとバーの地が本文より明るくなり、下端に境目が帯として出る。
				// バーは素通しにして、**渡す画面が本文側に `HeaderEdgeFade` を敷く**。
				headerStyle: { backgroundColor: 'transparent' },
			}
			: { headerStyle: { backgroundColor: colors.bg } }),
	}), [hidden, headerTitle, headerRight, translucent]);

	return <Stack.Screen options={options} />;
}

/**
 * 半透明にしたバーの高さ（セーフエリアを除いた分）。**渡す画面が本文の上余白に使う。**
 *
 * `useHeaderHeight` が expo-router から使えないので実測値を置く。タイトル＋サブタイトルの
 * 2行構成のバーを実機のフレームから測った値（サブタイトルが無い画面では少し余分に空く）。
 */
export const NATIVE_BAR_HEIGHT = 59;

/** アバターの地色。色の指定は `#rrggbb` 前提（テーマの色はすべてこの形）。 */
function withAlpha(color: string): string {
	return color.length === 7 ? `${color}47` : colors.surface2;
}

const styles = StyleSheet.create({
	// 高さは決めない（バーが決める）。左の余白も付けない——バー項目の位置はOSが決める。
	island: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 6 },
	avatar: { width: 26, height: 26, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
	avatarText: { fontSize: 12, fontWeight: '800', fontFamily: mono.default },
	islandText: { flexShrink: 1, minWidth: 0, maxWidth: 150 },
	islandName: { color: colors.text, fontSize: 14, fontWeight: '700', letterSpacing: -0.2 },
	islandSub: { color: colors.textDim, fontSize: 10, marginTop: 1 },
	// 他のスペースに応答待ちが居る合図。器の縁に載るので、バーの地色で縁取る。
	badge: {
		position: 'absolute', top: -2, left: -2, width: 9, height: 9, borderRadius: radius.pill,
		backgroundColor: colors.red, borderWidth: 2, borderColor: colors.bg,
	},

	// **幅の上限を自分で持つ。** UIKitはカスタムのタイトルビューに幅を要求しないので、
	// 上限が無いと中身の長さのまま伸び、左の戻るボタンと右のボタンへ食い込む（長いタイトルと
	// 長いブランチ名で、サブ行が省略記号すら出さずにボタンの下へ消えていた。実機で確認済み）。
	// 中央に使える幅は「画面幅 − 2×max(左, 右)」。左は丸の戻るボタン、右はボタン1個なので、
	// 両側60ptを avoid した残りに収める。
	title: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, maxWidth: 240 },
	titleRow: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%' },
	titleText: { color: colors.text, fontSize: 16, fontWeight: '700', letterSpacing: -0.2, flexShrink: 1, minWidth: 0 },
	titleSub: { color: colors.textDim, fontSize: 10.5, marginTop: 1, maxWidth: '100%' },

	actions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
	actionHit: { width: 32, height: 32, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
	actionBadge: { position: 'absolute', top: 2, right: 2, width: 8, height: 8, borderRadius: radius.pill, borderWidth: 2, borderColor: colors.bg },
	actionBadgeRed: { backgroundColor: colors.red },
	actionBadgeGreen: { backgroundColor: colors.green },
});
