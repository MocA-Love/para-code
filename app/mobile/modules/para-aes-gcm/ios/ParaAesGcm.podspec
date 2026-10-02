# PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
Pod::Spec.new do |s|
  s.name           = 'ParaAesGcm'
  s.version        = '1.0.0'
  s.summary        = 'Synchronous AES-256-GCM open and seal for the mobile relay channel'
  s.description    = 'Opens and seals the E2E frames (nonce(12) || ciphertext || tag(16)) with CryptoKit from a synchronous Expo function, so the JS receive path stays synchronous.'
  s.author         = 'Paradis'
  s.homepage       = 'https://paradis.ltd'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
