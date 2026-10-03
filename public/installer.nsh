; Installer hooks, run by electron-builder's NSIS target.

; Windows' per-program graphics setting, the one under Settings > System >
; Display > Graphics. A laptop with two GPUs hands a program the power-saving
; one unless told otherwise, and on integrated graphics a hazy rig runs at a
; few frames a second. GpuPreference=2 is "High performance".
;
; Per user: a per-machine install run under another administrator's account
; sets it for that account. The app asks Chromium for the discrete GPU as well
; (force_high_performance_gpu in main.js), which covers that case.
!macro customInstall
  WriteRegStr HKCU "Software\Microsoft\DirectX\UserGpuPreferences" "$INSTDIR\Beam.exe" "GpuPreference=2;"
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\DirectX\UserGpuPreferences" "$INSTDIR\Beam.exe"
!macroend
