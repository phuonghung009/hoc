@echo off
cd /d "%~dp0"
echo ================================================
echo   DE THI TIENG ANH 6 - BUILD APK DEBUG
echo ================================================
echo.
call gradlew.bat :app:assembleDebug
if errorlevel 1 (
  echo.
  echo BUILD THAT BAI. Xem loi o phia tren.
  pause
  exit /b 1
)
echo.
echo BUILD THANH CONG!
echo APK: app\build\outputs\apk\debug\app-debug.apk
pause
