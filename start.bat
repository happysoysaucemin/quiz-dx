@echo off
chcp 65001 >nul
cd /d "%~dp0server"
echo 正在启动 刷题 DX ...
echo 打开 http://localhost:8787
node server.mjs
pause
