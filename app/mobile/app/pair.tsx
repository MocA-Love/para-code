// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAppStore } from '../src/appState.js';

/**
 * ペアリング画面: カメラでQRを読み取り、PCと接続する。
 * 読み取り後に表示されるSAS 6桁を、PC側ダイアログの6桁と突き合わせてもらう。
 *
 * PC側は現状 QR 画像ではなく paracode-mobile://pair の URI テキストをダイアログに表示するのみ
 * （QR描画ライブラリは未同梱）。またシミュレータには実カメラが無くQRスキャンを試せないため、
 * URI を直接貼り付けて接続する手動入力を併設する。
 */
export default function PairScreen() {
	const router = useRouter();
	const pairFromUri = useAppStore(s => s.pairFromUri);
	const cancelPairing = useAppStore(s => s.cancelPairing);
	const [permission, requestPermission] = useCameraPermissions();
	const [sas, setSas] = useState<string | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [scanning, setScanning] = useState(true);
	const [pasteMode, setPasteMode] = useState(false);
	const [pastedUri, setPastedUri] = useState('');
	const [connecting, setConnecting] = useState(false);

	// 画面を閉じたら進行中のペアリングを中断する（無応答ソケットの残留と、
	// 離脱後に裏で接続が成立してしまうのを防ぐ）。
	useEffect(() => {
		return () => { cancelPairing(); };
	}, [cancelPairing]);

	// カメラでのQRスキャンをデフォルト導線にするため、権限が未確定/未許可（まだ
	// 尋ねていない）の間に自動でリクエストする。拒否された場合やシミュレータ等で
	// ハードウェアが無い場合は permission.granted が false のままなのでリンク貼り付けへ
	// フォールバックする（pasteMode || !permission.granted の分岐、下記参照）。
	useEffect(() => {
		if (permission && !permission.granted && permission.canAskAgain) {
			void requestPermission();
		}
	}, [permission, requestPermission]);

	const connect = async (uri: string) => {
		setError(undefined);
		try {
			await pairFromUri(uri, deviceName(), code => setSas(code));
			router.back();
		} catch (e) {
			setError(String(e));
			setScanning(true);
			setConnecting(false);
		}
	};

	const onScan = async (data: string) => {
		if (!scanning) {
			return;
		}
		setScanning(false);
		await connect(data);
	};

	const onSubmitPasted = async () => {
		if (!pastedUri.trim() || connecting) {
			return;
		}
		setConnecting(true);
		await connect(pastedUri.trim());
	};

	if (sas) {
		return (
			<View style={styles.center}>
				<Image source={require('../assets/pairing-logo.png')} style={styles.appIcon} resizeMode="contain" />
				<Text style={styles.title}>Para Code と接続</Text>
				<Text style={styles.dim}>PC 側に表示されている 6 桁と一致することを確認してください。</Text>
				<Text style={styles.sas}>{sas.slice(0, 3)} {sas.slice(3)}</Text>
				<Text style={styles.dim}>PC で「接続を承認」を押すと接続が完了します。{'\n'}接続はエンドツーエンドで暗号化されます</Text>
			</View>
		);
	}

	// 権限の確定前（初回マウント直後、上のuseEffectでリクエスト中）はリンク貼り付けに
	// 落とさず、確定を待つ（ここでリンク貼り付けを先に出すと、許可済みの実機でも
	// 一瞬リンク貼り付け画面が見えてからカメラに切り替わるチラつきが起きるため）。
	if (!permission) {
		return <View style={styles.center}><Text style={styles.dim}>カメラを準備中…</Text></View>;
	}

	if (pasteMode || !permission.granted) {
		return (
			<KeyboardAvoidingView style={styles.center} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
				<Text style={styles.title}>リンクを貼り付けて接続</Text>
				<Text style={styles.dim}>PC の Para Code に表示された paracode-mobile://pair の リンクを貼り付けてください。</Text>
				<TextInput
					style={styles.input}
					value={pastedUri}
					onChangeText={setPastedUri}
					placeholder="paracode-mobile://pair?d=..."
					placeholderTextColor="#8b8b8b"
					autoCapitalize="none"
					autoCorrect={false}
					multiline
				/>
				{error ? <Text style={styles.error}>{error}</Text> : null}
				<Pressable style={styles.primaryBtn} onPress={onSubmitPasted} disabled={connecting}>
					<Text style={styles.primaryBtnText}>{connecting ? '接続中…' : '接続'}</Text>
				</Pressable>
				{!permission.granted ? (
					<Pressable onPress={requestPermission}><Text style={styles.linkText}>カメラでQRを読み取る</Text></Pressable>
				) : (
					<Pressable onPress={() => setPasteMode(false)}><Text style={styles.linkText}>QRを読み取る（カメラを使う）</Text></Pressable>
				)}
			</KeyboardAvoidingView>
		);
	}

	return (
		<View style={styles.screen}>
			<CameraView
				style={StyleSheet.absoluteFill}
				barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
				onBarcodeScanned={scanning ? ({ data }) => { void onScan(data); } : undefined}
			/>
			<View style={styles.overlay}>
				<Text style={styles.scanHint}>PC の Para Code に表示された QR を枠に収めてください</Text>
				{error ? <Text style={styles.error}>{error}</Text> : null}
				<Pressable onPress={() => setPasteMode(true)}><Text style={styles.linkTextLight}>リンクを貼り付けて接続</Text></Pressable>
			</View>
		</View>
	);
}

function deviceName(): string {
	return 'モバイルデバイス';
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: '#000' },
	center: { flex: 1, backgroundColor: '#0d1117', alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 },
	title: { color: '#fff', fontSize: 22, fontWeight: '700' },
	dim: { color: '#8b8b8b', fontSize: 13, textAlign: 'center', lineHeight: 20 },
	sas: { color: '#09AFD9', fontSize: 44, fontWeight: '700', letterSpacing: 10, fontVariant: ['tabular-nums'] },
	appIcon: { width: 72, height: 72 },
	overlay: { position: 'absolute', bottom: 60, left: 20, right: 20, alignItems: 'center', gap: 8 },
	scanHint: { color: '#fff', fontSize: 13, textAlign: 'center', backgroundColor: 'rgba(0,0,0,0.6)', padding: 10, borderRadius: 8, overflow: 'hidden' },
	error: { color: '#f48771', fontSize: 12, textAlign: 'center' },
	primaryBtn: { backgroundColor: '#0598BD', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 24 },
	primaryBtnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
	input: { width: '100%', minHeight: 90, backgroundColor: '#252526', borderRadius: 10, borderWidth: 1, borderColor: '#3c3c3c', color: '#cccccc', fontSize: 13, padding: 12, textAlignVertical: 'top' },
	linkText: { color: '#09AFD9', fontSize: 13, marginTop: 4 },
	linkTextLight: { color: '#fff', fontSize: 13, textDecorationLine: 'underline' },
});
