@echo off
rem AE64 Max Control - trinh khoi dong hang ngay.
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo Dang cai dat thu vien...
  call npm install || goto :fail
)
if not exist dist\index.html (
  echo Dang build ung dung...
  call npm run build || goto :fail
)
echo Mo http://127.0.0.1:4173 ... (dong cua so nay de tat)
rem --open lets Vite open the browser once the server is listening.
call npm run preview -- --open
goto :eof
:fail
echo Loi khi khoi dong. Xem thong bao o tren.
pause
