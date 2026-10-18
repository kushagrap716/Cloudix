@echo off
REM Builds ONLY the Windows installer: desktop\release\Cloudix Setup 1.0.1.exe  (no portable exe, no unpacked folder).
REM Needs Node.js 20+ from nodejs.org and an internet connection (first run downloads the packages and the bundled database).
cd /d "%~dp0desktop"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)

echo [1/3] Installing packages...
call npm install || (echo npm install failed & pause & exit /b 1)

echo [2/3] Building the app, the server and the bundled database...
call npm run build:app || (echo Build failed & pause & exit /b 1)

echo [3/3] Packaging the installer...
call npx electron-builder --win nsis || (echo Packaging the installer failed & pause & exit /b 1)

echo.
echo Done. Your installer is in: %~dp0desktop\release
for %%F in ("%~dp0desktop\release\*Setup*.exe") do echo   %%~nxF
start "" "%~dp0desktop\release"
pause
