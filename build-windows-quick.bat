@echo off
REM Quick build: makes a ready-to-run app folder (no installer, no compression), so it finishes much faster.
REM Result: desktop\release\win-unpacked\Cloudix.exe   Run on Windows. Needs Node.js 20+ from nodejs.org.
cd /d "%~dp0desktop"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
call npm install || (echo npm install failed & pause & exit /b 1)
call npm run pack:win || (echo Build failed & pause & exit /b 1)
echo.
echo Done. Run: %~dp0desktop\release\win-unpacked\Cloudix.exe
start "" "%~dp0desktop\release\win-unpacked"
pause
