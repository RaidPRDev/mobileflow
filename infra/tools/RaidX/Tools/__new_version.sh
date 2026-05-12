#!/bin/bash

# Ionic Capacitor Vue iOS Build & Archive Script
# This script builds the Vue app, syncs with iOS, and creates an Xcode archive

set -e  # Exit on any error

# =============================================================================
# CONFIGURATION VARIABLES
# =============================================================================

# Project Configuration
PROJECT_DIR="$(pwd)"
IOS_PROJECT_DIR="$PROJECT_DIR/ios"
APP_TARGET="App"
PODS_TARGET="Pods-App"
SCHEME_NAME="App"
WORKSPACE_NAME="App.xcworkspace"

# Build Configuration
CONFIGURATION="Release"  # or "Debug"
ARCHIVE_PATH="$PROJECT_DIR/build/App.xcarchive"
BUILD_DIR="$PROJECT_DIR/build"

# Code Signing Configuration (Set these as environment variables or modify directly)
P12_PATH="${P12_PATH:-}"                    # Path to your .p12 certificate file
P12_PASSWORD="${P12_PASSWORD:-}"            # Password for .p12 certificate
PROVISIONING_PROFILE="${PROVISIONING_PROFILE:-}"  # Path to provisioning profile
TEAM_ID="${TEAM_ID:-}"                      # Your Apple Developer Team ID
CODE_SIGN_IDENTITY="${CODE_SIGN_IDENTITY:-iPhone Distribution}"  # Code signing identity

# App Configuration
BUNDLE_ID="${BUNDLE_ID:-}"                  # Your app's bundle identifier
APP_VERSION="${APP_VERSION:-1.0.0}"        # App version
BUILD_NUMBER="${BUILD_NUMBER:-1}"          # Build number

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

print_step() {
    echo -e "${BLUE}📋 $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

check_requirements() {
    print_step "Checking requirements..."
    
    # Check if we're on macOS
    if [[ "$OSTYPE" != "darwin"* ]]; then
        print_error "This script must be run on macOS"
        exit 1
    fi
    
    # Check for required tools
    local required_tools=("node" "npm" "ionic" "xcodebuild" "security")
    
    for tool in "${required_tools[@]}"; do
        if ! command -v "$tool" &> /dev/null; then
            print_error "$tool is not installed or not in PATH"
            exit 1
        fi
    done
    
    # Check if iOS project exists
    if [[ ! -d "$IOS_PROJECT_DIR" ]]; then
        print_error "iOS project directory not found at $IOS_PROJECT_DIR"
        exit 1
    fi
    
    # Check if workspace exists
    if [[ ! -f "$IOS_PROJECT_DIR/$WORKSPACE_NAME" ]]; then
        print_error "Xcode workspace not found at $IOS_PROJECT_DIR/$WORKSPACE_NAME"
        exit 1
    fi
    
    print_success "All requirements check passed"
}

setup_keychain() {
    if [[ -n "$P12_PATH" && -n "$P12_PASSWORD" ]]; then
        print_step "Setting up keychain for code signing..."
        
        # Create a temporary keychain
        local keychain_name="build-keychain"
        local keychain_password="temp-password"
        
        # Delete existing keychain if it exists
        security delete-keychain "$keychain_name" 2>/dev/null || true
        
        # Create new keychain
        security create-keychain -p "$keychain_password" "$keychain_name"
        security set-keychain-settings -lut 21600 "$keychain_name"
        security unlock-keychain -p "$keychain_password" "$keychain_name"
        
        # Add keychain to search list
        security list-keychains -d user -s "$keychain_name" $(security list-keychains -d user | sed s/\"//g)
        
        # Import certificate
        security import "$P12_PATH" -k "$keychain_name" -P "$P12_PASSWORD" -T /usr/bin/codesign
        
        # Set partition list for the certificate
        security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain_name"
        
        print_success "Keychain setup completed"
    else
        print_warning "P12_PATH or P12_PASSWORD not provided, skipping keychain setup"
    fi
}

install_provisioning_profile() {
    if [[ -n "$PROVISIONING_PROFILE" && -f "$PROVISIONING_PROFILE" ]]; then
        print_step "Installing provisioning profile..."
        
        local profiles_dir="$HOME/Library/MobileDevice/Provisioning Profiles"
        mkdir -p "$profiles_dir"
        cp "$PROVISIONING_PROFILE" "$profiles_dir/"
        
        print_success "Provisioning profile installed"
    else
        print_warning "PROVISIONING_PROFILE not provided or file not found"
    fi
}

# =============================================================================
# BUILD FUNCTIONS
# =============================================================================

install_dependencies() {
    print_step "Installing Node.js dependencies..."
    npm install
    print_success "Dependencies installed"
}

build_vue_app() {
    print_step "Building Vue application..."
    npm run build
    print_success "Vue app built successfully"
}

sync_capacitor() {
    print_step "Syncing Capacitor with iOS..."
    
    # Update Capacitor dependencies if needed
    npx cap update ios
    
    # Sync the web assets with the native iOS project
    npx cap sync ios
    
    print_success "Capacitor sync completed"
}

update_ios_config() {
    if [[ -n "$BUNDLE_ID" ]]; then
        print_step "Updating iOS configuration..."
        
        # Update bundle identifier, version, and build number using PlistBuddy
        local info_plist="$IOS_PROJECT_DIR/$APP_TARGET/Info.plist"
        
        if [[ -f "$info_plist" ]]; then
            /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$info_plist"
            /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $APP_VERSION" "$info_plist"
            /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$info_plist"
            
            print_success "iOS configuration updated"
        else
            print_warning "Info.plist not found, skipping configuration update"
        fi
    fi
}

clean_build_directory() {
    print_step "Cleaning build directory..."
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"
    print_success "Build directory cleaned"
}

build_pods_target() {
    print_step "Building CocoaPods target..."
    
    cd "$IOS_PROJECT_DIR"
    
    # Build the Pods target first
    xcodebuild build \
        -workspace "$WORKSPACE_NAME" \
        -scheme "$PODS_TARGET" \
        -configuration "$CONFIGURATION" \
        -sdk iphoneos \
        ONLY_ACTIVE_ARCH=NO
    
    if [[ $? -eq 0 ]]; then
        print_success "CocoaPods target built successfully"
    else
        print_error "Failed to build CocoaPods target"
        exit 1
    fi
}

build_ios_project() {
    print_step "Building iOS project..."
    
    cd "$IOS_PROJECT_DIR"
    
    # Clean the project first
    xcodebuild clean \
        -workspace "$WORKSPACE_NAME" \
        -scheme "$SCHEME_NAME" \
        -configuration "$CONFIGURATION"
    
    print_success "iOS project cleaned"
    
    # Build CocoaPods target first
    build_pods_target
}

create_archive() {
    print_step "Creating Xcode archive..."
    
    cd "$IOS_PROJECT_DIR"
    
    # Build archive command
    local archive_cmd="xcodebuild archive"
    archive_cmd+=" -workspace $WORKSPACE_NAME"
    archive_cmd+=" -scheme $SCHEME_NAME"
    archive_cmd+=" -configuration $CONFIGURATION"
    archive_cmd+=" -archivePath $ARCHIVE_PATH"
    archive_cmd+=" -allowProvisioningUpdates"
    
    # Add code signing parameters if provided
    if [[ -n "$TEAM_ID" ]]; then
        archive_cmd+=" DEVELOPMENT_TEAM=$TEAM_ID"
    fi
    
    if [[ -n "$CODE_SIGN_IDENTITY" ]]; then
        archive_cmd+=" CODE_SIGN_IDENTITY=\"$CODE_SIGN_IDENTITY\""
    fi
    
    if [[ -n "$BUNDLE_ID" ]]; then
        archive_cmd+=" PRODUCT_BUNDLE_IDENTIFIER=$BUNDLE_ID"
    fi
    
    # Execute the archive command
    eval $archive_cmd
    
    if [[ $? -eq 0 ]]; then
        print_success "Archive created successfully at: $ARCHIVE_PATH"
    else
        print_error "Archive creation failed"
        exit 1
    fi
}

cleanup_keychain() {
    if [[ -n "$P12_PATH" && -n "$P12_PASSWORD" ]]; then
        print_step "Cleaning up temporary keychain..."
        security delete-keychain "build-keychain" 2>/dev/null || true
        print_success "Keychain cleanup completed"
    fi
}

# =============================================================================
# MAIN EXECUTION
# =============================================================================

main() {
    print_step "Starting Ionic Capacitor iOS build process..."
    echo "Project Directory: $PROJECT_DIR"
    echo "iOS Directory: $IOS_PROJECT_DIR"
    echo "Configuration: $CONFIGURATION"
    echo "Archive Path: $ARCHIVE_PATH"
    echo ""
    
    # Pre-build checks and setup
    check_requirements
    setup_keychain
    install_provisioning_profile
    clean_build_directory
    
    # Build process
    install_dependencies
    build_vue_app
    sync_capacitor
    update_ios_config
    build_ios_project
    create_archive
    
    # Cleanup
    cleanup_keychain
    
    print_success "🎉 Build process completed successfully!"
    print_success "Archive location: $ARCHIVE_PATH"
    echo ""
    echo "Next steps:"
    echo "1. You can now create an IPA using Xcode Organizer or xcodebuild -exportArchive"
    echo "2. For automated IPA export, you'll need an ExportOptions.plist file"
}

# =============================================================================
# SCRIPT EXECUTION
# =============================================================================

# Handle script arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --configuration)
            CONFIGURATION="$2"
            shift 2
            ;;
        --bundle-id)
            BUNDLE_ID="$2"
            shift 2
            ;;
        --version)
            APP_VERSION="$2"
            shift 2
            ;;
        --build-number)
            BUILD_NUMBER="$2"
            shift 2
            ;;
        --help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --configuration CONFIG    Build configuration (Debug/Release) [default: Release]"
            echo "  --bundle-id ID            App bundle identifier"
            echo "  --version VERSION         App version [default: 1.0.0]"
            echo "  --build-number NUMBER     Build number [default: 1]"
            echo "  --help                    Show this help message"
            echo ""
            echo "Environment Variables:"
            echo "  P12_PATH                  Path to .p12 certificate file"
            echo "  P12_PASSWORD              Password for .p12 certificate"
            echo "  PROVISIONING_PROFILE      Path to provisioning profile"
            echo "  TEAM_ID                   Apple Developer Team ID"
            echo "  CODE_SIGN_IDENTITY        Code signing identity"
            echo ""
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Run main function
main