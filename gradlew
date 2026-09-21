#!/bin/sh
APP_HOME=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WRAPPER_JAR="$APP_HOME/gradle/wrapper/gradle-wrapper.jar"
if [ ! -f "$WRAPPER_JAR" ]; then
  echo "[DeThiTiengAnh6] Downloading Gradle Wrapper 8.7..."
  if command -v curl >/dev/null 2>&1; then
    curl -fL "https://raw.githubusercontent.com/gradle/gradle/v8.7.0/gradle/wrapper/gradle-wrapper.jar" -o "$WRAPPER_JAR" || exit 1
  else
    echo "curl is required to download gradle-wrapper.jar"
    exit 1
  fi
fi
if [ -n "$JAVA_HOME" ]; then JAVA_CMD="$JAVA_HOME/bin/java"; else JAVA_CMD="java"; fi
exec "$JAVA_CMD" -classpath "$WRAPPER_JAR" org.gradle.wrapper.GradleWrapperMain "$@"
