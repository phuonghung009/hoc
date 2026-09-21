@echo off
setlocal
set APP_HOME=%~dp0
set WRAPPER_JAR=%APP_HOME%gradle\wrapper\gradle-wrapper.jar
if not exist "%WRAPPER_JAR%" (
  echo [DeThiTiengAnh6] Dang tai Gradle Wrapper 8.7...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/gradle/gradle/v8.7.0/gradle/wrapper/gradle-wrapper.jar' -OutFile '%WRAPPER_JAR%'"
  if errorlevel 1 (
    echo Khong tai duoc gradle-wrapper.jar. Hay kiem tra Internet.
    exit /b 1
  )
)
"%JAVA_HOME%\bin\java.exe" -version >nul 2>&1
if errorlevel 1 (
  where java >nul 2>&1
  if errorlevel 1 (
    echo Khong tim thay Java. Hay cai Android Studio/JDK 17 truoc.
    exit /b 1
  )
  set JAVA_CMD=java
) else (
  set JAVA_CMD=%JAVA_HOME%\bin\java.exe
)
%JAVA_CMD% -classpath "%WRAPPER_JAR%" org.gradle.wrapper.GradleWrapperMain %*
endlocal
