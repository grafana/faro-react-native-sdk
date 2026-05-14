#!/bin/sh
# Upload composed Hermes source map (iOS Release).
# Invoked from an autolinked Xcode Run Script phase. Expects FARO_BUNDLE_ID,
# FARO_SOURCEMAP_ENDPOINT, FARO_SOURCEMAP_APP_ID, FARO_SOURCEMAP_STACK_ID,
# FARO_SOURCEMAP_API_KEY, and optional FARO_SKIP_SOURCEMAP_UPLOAD (same names as `faro-cli metro upload`).
# Never fails the build — logs warnings and exits 0 when skipping.

set -e

# Xcode CONFIGURATION is typically "Debug" or "Release"
case "$(printf '%s' "${CONFIGURATION:-}" | tr '[:upper:]' '[:lower:]')" in
  release) ;;
  *)
    echo "[Faro] Skipping composed source map upload (configuration: ${CONFIGURATION:-unknown}, not Release)."
    exit 0
    ;;
esac

case "${FARO_SKIP_SOURCEMAP_UPLOAD:-}" in
  1 | true | TRUE)
    echo "[Faro] Skipping composed source map upload (FARO_SKIP_SOURCEMAP_UPLOAD=${FARO_SKIP_SOURCEMAP_UPLOAD})."
    exit 0
    ;;
esac

# Source before FARO_* checks so credentials can live in .xcode.env / .xcode.env.local
# (matches react-native-xcode.sh / with-environment.sh order).
ENV_FILE="${SRCROOT}/.xcode.env.local"
[ -f "$ENV_FILE" ] || ENV_FILE="${SRCROOT}/.xcode.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# Application JS root (parent of ios/)
JS_ROOT="${SRCROOT}/.."
CLI_PATH="$JS_ROOT/node_modules/@grafana/faro-metro-plugin/bin/faro-upload-source-map.js"

if [ ! -f "$CLI_PATH" ]; then
  echo "warning: [Faro] Skipping composed source map upload — shim not found at ${CLI_PATH}. Install @grafana/faro-metro-plugin (devDependency) alongside @grafana/faro-react-native."
  exit 0
fi

# React Native Hermes pipeline writes the composed map to SOURCEMAP_FILE when set in
# Xcode build settings (see RN release / FE O11y docs). Fallback for common layouts.
MAP="${SOURCEMAP_FILE:-}"
if [ -z "$MAP" ]; then
  MAP="${CONFIGURATION_BUILD_DIR}/main.jsbundle.map"
fi

if [ ! -f "$MAP" ]; then
  echo "warning: [Faro] Skipping composed source map upload — map not found at ${MAP}."
  echo "warning: [Faro] For iOS Release + Hermes, set SOURCEMAP_FILE in Xcode Release (e.g. \$(DERIVED_FILE_DIR)/main.jsbundle.map) so react-native-xcode.sh composes main.jsbundle.map."
  exit 0
fi

MISSING=""
[ -z "${FARO_BUNDLE_ID:-}" ] && MISSING="${MISSING}FARO_BUNDLE_ID "
[ -z "${FARO_SOURCEMAP_ENDPOINT:-}" ] && MISSING="${MISSING}FARO_SOURCEMAP_ENDPOINT "
[ -z "${FARO_SOURCEMAP_APP_ID:-}" ] && MISSING="${MISSING}FARO_SOURCEMAP_APP_ID "
[ -z "${FARO_SOURCEMAP_STACK_ID:-}" ] && MISSING="${MISSING}FARO_SOURCEMAP_STACK_ID "
[ -z "${FARO_SOURCEMAP_API_KEY:-}" ] && MISSING="${MISSING}FARO_SOURCEMAP_API_KEY "

if [ -n "$MISSING" ]; then
  echo "warning: [Faro] Skipping composed source map upload — missing env: ${MISSING}"
  echo "warning: [Faro] Export FARO_BUNDLE_ID and FARO_SOURCEMAP_* in the shell running xcodebuild, or add them to ios/.xcode.env.local."
  exit 0
fi

NODE_BIN="${NODE_BINARY:-node}"

exec "$NODE_BIN" "$CLI_PATH" \
  --verbose \
  --map "$MAP" \
  --endpoint "$FARO_SOURCEMAP_ENDPOINT" \
  --app-id "$FARO_SOURCEMAP_APP_ID" \
  --stack-id "$FARO_SOURCEMAP_STACK_ID" \
  --api-key "$FARO_SOURCEMAP_API_KEY" \
  --bundle-id "$FARO_BUNDLE_ID"
