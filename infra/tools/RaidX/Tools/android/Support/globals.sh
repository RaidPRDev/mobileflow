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
# `console=plain` because rich mode also draws an animated progress bar
# ("<====> 97% EXECUTING [38s]"), which only makes sense on a terminal that can
# redraw a line — in the stored build log it accumulates into an unreadable
# run-on string. Plain still prints "> Task :app:bundleRelease" per task, and
# the web UI's regex highlighter colors timestamps/levels/paths on top, so we
# lose little. FORCE_COLOR/CLICOLOR_FORCE still cover the rest of the toolchain
# (npm, pod, capacitor, clang), which emit color without a progress area.
export GRADLE_OPTS="-Xmx4096m -Dorg.gradle.daemon=false -Dorg.gradle.console=plain"
export FORCE_COLOR=1
export CLICOLOR_FORCE=1
export TERM=xterm-256color
