// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import CryptoKit
import ExpoModulesCore
import Foundation

/// PC とのセッションのフレームの AES-256-GCM を CryptoKit で開く・封緘する。
///
/// 形式は `nonce(12) || 暗号文 || タグ(16)`（`app/protocol/src/crypto.ts`。PC の webcrypto・@noble と同じ並び）。
/// `AES.GCM.SealedBox(combined:)` は 12 バイトの nonce 専用で、この形をそのまま読める
/// （`ios/NotifyExtension/NotificationService.swift` が通知の封緘を同じ形で開いている）。
///
/// どちらも同期の `Function`（JS のスレッドで実行）にしてある。受信の経路（`FrameMux.receive` → `SecureChannel.open`）が
/// 同期なので、非同期にすると経路ごと作り直しになるため。引数の `Uint8Array` は JS のメモリを直接読み、
/// この関数の外（別スレッド）へ持ち出さない。戻り値は CryptoKit が作った `Data` をコピーせずに ArrayBuffer として返す。
public final class ParaAesGcmModule: Module {
	public func definition() -> ModuleDefinition {
		Name("ParaAesGcm")

		/// `sealed`（`nonce(12) || 暗号文 || タグ(16)`）を開いて平文を返す。認証に失敗したら throw する。
		Function("open") { (key: Uint8Array, sealed: Uint8Array) throws -> NativeArrayBuffer in
			let symmetricKey = try ParaAesGcm.symmetricKey(key)
			guard sealed.byteLength >= ParaAesGcm.nonceLength + ParaAesGcm.tagLength else {
				throw ParaAesGcmInvalidInputException("sealed message is too short (\(sealed.byteLength) bytes)")
			}
			// JS のメモリをコピーせずに見る。`box` と `combined` はこのクロージャの中でだけ使う。
			let combined = Data(bytesNoCopy: sealed.rawPointer, count: sealed.byteLength, deallocator: .none)
			let plaintext: Data
			do {
				let box = try AES.GCM.SealedBox(combined: combined)
				plaintext = try AES.GCM.open(box, using: symmetricKey)
			} catch {
				throw ParaAesGcmAuthenticationException(String(describing: error))
			}
			return ParaAesGcm.arrayBuffer(plaintext)
		}

		/// `plaintext` を `nonce`（12 バイト）で封緘し、`nonce(12) || 暗号文 || タグ(16)` を返す。
		Function("seal") { (key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array) throws -> NativeArrayBuffer in
			let symmetricKey = try ParaAesGcm.symmetricKey(key)
			guard nonce.byteLength == ParaAesGcm.nonceLength else {
				throw ParaAesGcmInvalidInputException("nonce must be \(ParaAesGcm.nonceLength) bytes (got \(nonce.byteLength))")
			}
			let gcmNonce = try AES.GCM.Nonce(data: Data(bytes: nonce.rawPointer, count: nonce.byteLength))
			let message = Data(bytesNoCopy: plaintext.rawPointer, count: plaintext.byteLength, deallocator: .none)
			let box = try AES.GCM.seal(message, using: symmetricKey, nonce: gcmNonce)
			guard let combined = box.combined else {
				// 12 バイトの nonce なら必ず combined を持つ（ここには来ない）。
				throw ParaAesGcmInvalidInputException("sealed box has no combined representation")
			}
			return ParaAesGcm.arrayBuffer(combined)
		}
	}
}

private enum ParaAesGcm {
	static let nonceLength = 12
	static let tagLength = 16
	static let keyLength = 32

	/// CryptoKit が作った `Data` をコピーせずに JS の ArrayBuffer として見せる。空のときは `bytes` が NULL になりうるので別に作る。
	static func arrayBuffer(_ data: Data) -> NativeArrayBuffer {
		if data.isEmpty {
			return NativeArrayBuffer.allocate(size: 0)
		}
		return NativeArrayBuffer.wrap(dataWithoutCopy: data)
	}

	/// AES-256 の鍵だけを受ける（`SymmetricKey` は長さを問わず作れてしまい、128/192 ビットの鍵でも動いてしまうため）。
	static func symmetricKey(_ key: Uint8Array) throws -> SymmetricKey {
		guard key.byteLength == keyLength else {
			throw ParaAesGcmInvalidInputException("key must be \(keyLength) bytes (got \(key.byteLength))")
		}
		return SymmetricKey(data: Data(bytes: key.rawPointer, count: key.byteLength))
	}
}

/// 認証に失敗した（改ざん・鍵違い）。
final class ParaAesGcmAuthenticationException: GenericException<String>, @unchecked Sendable {
	override var reason: String {
		"AES-GCM authentication failed: \(param)"
	}
}

/// 引数の長さが合わない。
final class ParaAesGcmInvalidInputException: GenericException<String>, @unchecked Sendable {
	override var reason: String {
		param
	}
}
