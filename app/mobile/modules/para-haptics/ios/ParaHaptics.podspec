# PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
Pod::Spec.new do |s|
  s.name           = 'ParaHaptics'
  s.version        = '1.0.0'
  s.summary        = 'Haptic tokens for Para Code Mobile (UIFeedbackGenerator with intensity and Core Haptics patterns)'
  s.description    = 'Keeps the UIKit feedback generators prepared, plays impacts with an explicit intensity, and plays Core Haptics transients and AHAP patterns from a held CHHapticEngine.'
  s.author         = 'Paradis'
  s.homepage       = 'https://paradis.ltd'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreHaptics'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
