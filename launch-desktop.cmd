@echo off
REM DSH InnateOS launcher (Windows).
REM Prefers the packaged build (dist-package/win-unpacked); falls back to dev mode.
REM userData is pinned to live-user-data so the app always opens in dev mode
REM with the saved workspace root (never the first-run mode gate).
setlocal
set "ROOT=%~dp0"
set "APP_DIR=%ROOT%innate-dogic\apps\desktop"
set "DIST=%APP_DIR%\dist-package"
set "USER_DATA=%DIST%\live-user-data"
set "EXE=%DIST%\win-unpacked\DSH InnateOS.exe"

if exist "%EXE%" (
  echo [launch] %EXE%
  start "" "%EXE%" --user-data-dir="%USER_DATA%"
  exit /b 0
)

echo [launch] packaged build not found, falling back to dev mode...
start "DSH InnateOS dev" cmd /k "cd /d %APP_DIR% && npm run dev"
exit /b 0
