# PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
Pod::Spec.new do |s|
  s.name           = 'ParaVoiceSession'
  s.version        = '1.0.0'
  s.summary        = 'Para Code background voice notification session'
  s.description    = 'Keeps an explicitly started playback-only audio session alive and plays voice clips pushed from the desktop.'
  s.author         = 'Paradis'
  s.homepage       = 'https://paradis.ltd'
  s.platforms      = { :ios => '16.2' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'AVFoundation', 'MediaPlayer'
  s.license        = { :type => 'MIT' }

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,swift}"
end
