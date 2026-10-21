#!/bin/sh
# Builds macos/build/WinDock.app (Release, signed ad hoc; no signing identity
# or Apple developer account needed). Usage: macos/build.sh [--test]
#   --test   also runs the unit tests first
set -eu
cd "$(dirname "$0")"

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen is required: brew install xcodegen" >&2
  exit 1
fi

xcodegen generate --quiet

if [ "${1:-}" = "--test" ]; then
  xcodebuild test -project WinDockMenu.xcodeproj -scheme WinDockMenu \
    -destination 'platform=macOS' -derivedDataPath build/DerivedData -quiet
fi

xcodebuild build -project WinDockMenu.xcodeproj -scheme WinDockMenu -configuration Release \
  -destination 'generic/platform=macOS' -derivedDataPath build/DerivedData \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= -quiet

rm -rf build/WinDock.app
ditto build/DerivedData/Build/Products/Release/WinDock.app build/WinDock.app
echo "Built $(pwd)/build/WinDock.app"
