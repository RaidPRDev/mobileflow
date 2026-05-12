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

# Gradle settings
export GRADLE_OPTS="-Xmx4096m -Dorg.gradle.daemon=false"
