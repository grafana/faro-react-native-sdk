# iOS frame monitoring tests

These XCTest cases compile the actual `ios/RefreshRateVitals.swift` without
React Native or CocoaPods. They cover lifecycle boundaries, accumulated metrics,
active-period stalls with injected timestamps, repeated initialization,
stale display links, cleanup, thresholds and ProMotion normalization.

On a Mac with Xcode and an installed iOS simulator, run from the repository root:

```sh
OUT=$(mktemp -d /tmp/faro-frame-tests.XXXXXX)
node packages/react-native/tests/ios/prepare.cjs "$OUT"
xcodebuild test -project "$OUT/FrameVitals.xcodeproj" -scheme FrameVitals \
  -destination 'platform=iOS Simulator,id=YOUR_SIMULATOR_UDID' \
  -derivedDataPath "$OUT/DerivedData" \
  -resultBundlePath "$OUT/results.xcresult" \
  -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO
```

The test runner targets iOS 17, while the pod supports iOS 13.4. These tests do
not cover that minimum runtime. They run on the main thread, matching the native
bridge's dispatch and UIKit lifecycle callbacks. They inject lifecycle
notifications and frame timestamps; they do not replace physical-device tests
of the real display link and app transitions.

Tests live outside `ios/` so the pod does not compile or ship XCTest sources.

## Lifecycle boundary

Monitoring measures intervals between active display ticks. An unfinished
interval at pause is discarded, and the first tick after activation seeds a new
baseline. A stall without a second active tick is therefore not classified as a
frozen frame. Completed slow episodes remain counted; an open episode is
discarded at pause. No wall-clock sample is substituted for a missing display
callback.
