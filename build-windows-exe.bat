@echo off
REM Builds the Cloudix desktop .exe (installer + portable). Run on Windows. Needs Node.js 20+ from nodejs.org.
cd /d "%~dp0desktop"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
call npm install || (echo npm install failed & pause & exit /b 1)
echo Building the app and bundling the server. This takes several minutes the first time and downloads about 90 MB (the included database).
call npm run dist:win || (echo Build failed & pause & exit /b 1)
echo.
echo Done. Your .exe files are in: %~dp0desktop\release
start "" "%~dp0desktop\release"
pause
