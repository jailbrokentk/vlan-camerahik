; installer.nsh - Custom NSIS script for pre-install cleanup

!macro customInit
  DetailPrint "Cleaning up old installation directories and AppData..."
  RMDir /r "$APPDATA\vLAN-CameraHIK"
  RMDir /r "$LOCALAPPDATA\vlan-camerahik-updater"
  RMDir /r "$INSTDIR"
!macroend
