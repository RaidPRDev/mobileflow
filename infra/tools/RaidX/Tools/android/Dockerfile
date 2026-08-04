FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}"

# System dependencies
#
# JDK 21, not 17: Capacitor 7's android library compiles at source release 21
# (`capacitor-android:compileReleaseJavaWithJavac` → "invalid source release:
# 21" under a 17 toolchain). javac 21 still builds older projects that ask for
# source 17, so this is safe for apps that haven't moved to Capacitor 7 yet.
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    git \
    openjdk-21-jdk \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs

# Android SDK Command Line Tools
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && curl -o /tmp/cmdline-tools.zip \
       https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
    && unzip /tmp/cmdline-tools.zip -d ${ANDROID_HOME}/cmdline-tools \
    && mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
    && rm /tmp/cmdline-tools.zip

# Accept licenses and install SDK components
RUN yes | sdkmanager --licenses \
    && sdkmanager \
       "platform-tools" \
       "platforms;android-35" \
       "platforms;android-34" \
       "build-tools;35.0.0" \
       "build-tools;34.0.0"

# Install Capacitor CLI globally
RUN npm install -g @capacitor/cli

WORKDIR /workspace
