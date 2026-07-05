// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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
	const [permission, requestPermission] = useCameraPermissions();
	const [sas, setSas] = useState<string | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [scanning, setScanning] = useState(true);
	const [pasteMode, setPasteMode] = useState(false);
	const [pastedUri, setPastedUri] = useState('');
	const [connecting, setConnecting] = useState(false);

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
				<View style={styles.appIcon}><Ionicons name="phone-portrait-outline" size={32} color="#fff" /></View>
				<Text style={styles.title}>Para Code と接続</Text>
				<Text style={styles.dim}>PC 側に表示されている 6 桁と一致することを確認してください。</Text>
				<Text style={styles.sas}>{sas.slice(0, 3)} {sas.slice(3)}</Text>
				<Text style={styles.dim}>PC で「接続を承認」を押すと接続が完了します。{'\n'}接続はエンドツーエンドで暗号化されます</Text>
			</View>
		);
	}

	if (pasteMode || !permission?.granted) {
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
				{permission && !permission.granted ? (
					<Pressable onPress={requestPermission}><Text style={styles.linkText}>カメラでQRを読み取る</Text></Pressable>
				) : (
					<Pressable onPress={() => setPasteMode(false)}><Text style={styles.linkText}>QRを読み取る（カメラを使う）</Text></Pressable>
				)}
			</KeyboardAvoidingView>
		);
	}

	if (!permission) {
		return <View style={styles.center}><Text style={styles.dim}>カメラを準備中…</Text></View>;
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
	sas: { color: '#4fc3f7', fontSize: 44, fontWeight: '700', letterSpacing: 10, fontVariant: ['tabular-nums'] },
	appIcon: { width: 72, height: 72, borderRadius: 18, backgroundColor: '#007acc', alignItems: 'center', justifyContent: 'center' },
	overlay: { position: 'absolute', bottom: 60, left: 20, right: 20, alignItems: 'center', gap: 8 },
	scanHint: { color: '#fff', fontSize: 13, textAlign: 'center', backgroundColor: 'rgba(0,0,0,0.6)', padding: 10, borderRadius: 8, overflow: 'hidden' },
	error: { color: '#f48771', fontSize: 12, textAlign: 'center' },
	primaryBtn: { backgroundColor: '#007acc', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 24 },
	primaryBtnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
	input: { width: '100%', minHeight: 90, backgroundColor: '#252526', borderRadius: 10, borderWidth: 1, borderColor: '#3c3c3c', color: '#cccccc', fontSize: 13, padding: 12, textAlignVertical: 'top' },
	linkText: { color: '#4fc3f7', fontSize: 13, marginTop: 4 },
	linkTextLight: { color: '#fff', fontSize: 13, textDecorationLine: 'underline' },
});
