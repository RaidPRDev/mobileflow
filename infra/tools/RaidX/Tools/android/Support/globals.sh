#!/bin/bash
# Android-specific global variables

# Paths (inside Docker container)
export WORKSPACE_DIR="/workspace"
export ANDROID_PROJECT_DIR="$WORKSPACE_DIR/android"
export ANDROID_BUILD_DIR="$ANDROID_PROJECT_DIR/app/build"
export ANDROID_OUTPUT_DIR="$ANDROID_BUILD_DIR/outputs"
export ANDROID_APK_DIR="$ANDROID_OUTPUT_DIR/apk/release"
export ANDROID_AAB_DIR="$ANDROID_OUTPUT_DIR/bundle/release"

# App configuration
export APP_MODULE="app"
export BUILD_TYPE="release"

# Gradle settings.
# `-Dorg.gradle.console=rich` makes Gradle emit ANSI even though docker run has
# no TTY; FORCE_COLOR/CLICOLOR_FORCE cover the rest of the toolchain (npm, pod,
# capacitor, clang). The MobileFlow web UI parses these escape codes and the
# regex highlighter colors timestamps/levels/paths on top.
export GRADLE_OPTS="-Xmx4096m -Dorg.gradle.daemon=false -Dorg.gradle.console=rich"
export FORCE_COLOR=1
export CLICOLOR_FORCE=1
export TERM=xterm-256color
