@echo off
title grabber - Next.js :3001
cd /d "%~dp0"
echo ================================================
echo  grabber (Next.js 14) ^=^> http://localhost:3001
echo  Bound to 0.0.0.0 - reachable via LAN / Tailscale
echo ================================================
echo.
call npm run dev -- -H 0.0.0.0 -p 3001
echo.
echo Server stopped. Press any key to close.
pause >nul
