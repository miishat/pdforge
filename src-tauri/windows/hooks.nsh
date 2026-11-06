; Extra installer steps (see bundle.windows.nsis.installerHooks in tauri.conf.json).

; "Make PDForge the default PDF app" registers PDForge in Settings > Default apps (src-tauri/src/shell.rs).
; Remove that registration when PDForge is uninstalled, but not during an update, which reinstalls in place.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\RegisteredApplications" "PDForge"
    DeleteRegKey HKCU "Software\PDForge\Capabilities"
    DeleteRegKey /ifempty HKCU "Software\PDForge"
    DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "PDForge.Document"
    DeleteRegKey HKCU "Software\Classes\PDForge.Document"
  ${EndIf}
!macroend
