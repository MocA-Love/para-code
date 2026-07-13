# PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
Pod::Spec.new do |s|
  s.name           = 'ParaLiveActivity'
  s.version        = '1.0.0'
  s.summary        = 'Para Code Live Activity bridge (ActivityKit)'
  s.description    = 'Starts/updates/ends the Para Code agent status Live Activity from JS.'
  s.author         = 'Paradis'
  s.homepage       = 'https://paradis.ltd'
  s.platforms      = { :ios => '16.2' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.license        = { :type => 'MIT' }

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,swift}"
end
