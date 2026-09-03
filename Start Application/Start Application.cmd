@echo off
setlocal EnableExtensions

set "APP_DIR=%~dp0.."
set "APP_PORT=56436"
set "APP_URL=http://localhost:%APP_PORT%/"
set "HEALTH_URL=%APP_URL%api/health"

cd /d "%APP_DIR%"

rem Reuse the application when its public health endpoint is already ready.
powershell.exe -NoProfile -Command "try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri '%HEALTH_URL%').StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
if not errorlevel 1 goto open_app

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo Node.js and npm are required to start this application.
  echo Install Node.js, then double-click this file again.
  pause
  exit /b 1
)

if not exist "%APP_DIR%\node_modules" (
  echo Installing application packages...
  call npm.cmd install
  if errorlevel 1 goto start_failed
)

if not exist "%APP_DIR%\work" mkdir "%APP_DIR%\work"

echo Starting Website Benchmark Dashboard at %APP_URL%...
powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'npm.cmd' -ArgumentList @('run','dev','--','--host','0.0.0.0','--port','%APP_PORT%','--strictPort') -WorkingDirectory '%APP_DIR%' -WindowStyle Hidden -RedirectStandardOutput '%APP_DIR%\work\dev-server-%APP_PORT%.log' -RedirectStandardError '%APP_DIR%\work\dev-server-%APP_PORT%-error.log'"

for /l %%I in (1,1,45) do (
  powershell.exe -NoProfile -Command "try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri '%HEALTH_URL%').StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
  if not errorlevel 1 goto open_app
  powershell.exe -NoProfile -Command "Start-Sleep -Seconds 1"
)

:start_failed
echo.
echo The application could not be started.
echo Check this log for details:
echo %APP_DIR%\work\dev-server-%APP_PORT%-error.log
pause
exit /b 1

:open_app
start "" "%APP_URL%"
exit /b 0
