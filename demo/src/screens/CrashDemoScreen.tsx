import React from 'react';
import {
  Alert,
  NativeModules,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

/**
 * Crash & Performance Demo Screen
 *
 * Demonstrates crash reporting and performance monitoring features:
 * - Native crashes (Java/Kotlin exceptions on Android, fatal errors on iOS)
 * - ANR simulation (blocking main thread on Android)
 * - UI freeze detection (frozen frames >100ms)
 * - Slow frame detection (frames <60 FPS)
 * - Heavy load simulation (combined performance issues)
 *
 * IMPORTANT: Crash reports are collected from PREVIOUS sessions.
 * When a crash occurs, the app terminates immediately.
 * On the next app launch, CrashReportingInstrumentation automatically
 * retrieves and sends the crash data to Grafana via:
 * - Android: ApplicationExitInfo API (Android 11+)
 * - iOS: PLCrashReporter
 *
 * NOTE: CrashTestModule is a demo-only native module. It is NOT part
 * of the Faro SDK - crash triggers should never be in production code.
 */
export function CrashDemoScreen() {
  // CrashTestModule is demo-only (for triggering test crashes)
  const { CrashTestModule } = NativeModules;

  /**
   * Trigger a native crash
   * - Android: Java/Kotlin RuntimeException
   * - iOS: Swift fatalError (SIGABRT)
   * This will crash the app immediately - you'll need to restart it
   */
  const triggerNativeCrash = () => {
    const platformDetails =
      Platform.OS === 'ios'
        ? 'This triggers a Swift fatalError (SIGABRT signal).'
        : 'This triggers a Java RuntimeException.';

    Alert.alert(
      '⚠️ Warning',
      `This will crash the app! ${platformDetails}\n\nThe crash report will be available after you restart the app.\n\nContinue?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Crash App',
          style: 'destructive',
          onPress: () => {
            if (CrashTestModule?.triggerTestCrash) {
              CrashTestModule.triggerTestCrash();
            } else {
              Alert.alert(
                'Not Available',
                `CrashTestModule is not available. Make sure you rebuilt the ${Platform.OS === 'ios' ? 'iOS' : 'Android'} app.`,
              );
            }
          },
        },
      ],
    );
  };

  /**
   * Trigger an ANR (Android) or UI Freeze (iOS) by blocking the main thread
   * - Android: System will force-kill the app after ~5-10 seconds, ANRInstrumentation will detect it
   * - iOS: Thread.sleep causes frame callbacks to be delayed, FrameMonitoringInstrumentation detects frozen frames
   * This demonstrates main thread blocking detection
   */
  const triggerANR = () => {
    const platformDetails =
      Platform.OS === 'ios'
        ? 'This blocks the main thread for 2 seconds.\n\n' +
          'When frame callbacks resume, they detect the time gap as a frozen frame (>100ms).\n\n' +
          'After ~5 seconds, FrameMonitoringInstrumentation will poll and log `app_frozen_frame` measurements.\n\n' +
          'Use "Check Frame Metrics" button to see frozen frame count immediately.'
        : 'The system will detect the unresponsive app and force-kill it. This records as REASON_ANR in ApplicationExitInfo.\n\n' +
          'On next app launch, ANRInstrumentation will send the ANR report to Faro.';

    const buttonLabel = Platform.OS === 'ios' ? 'Trigger Freeze' : 'Trigger ANR';

    Alert.alert(
      '⚠️ Warning',
      `This will freeze the app!\n\n${platformDetails}\n\nContinue?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: buttonLabel,
          style: 'destructive',
          onPress: () => {
            if (Platform.OS === 'ios') {
              // iOS: Use triggerFreeze for frame monitoring detection
              if (CrashTestModule?.triggerFreeze) {
                CrashTestModule.triggerFreeze();
              } else {
                Alert.alert(
                  'Not Available',
                  'CrashTestModule is not available. Make sure you rebuilt the iOS app.',
                );
              }
            } else {
              // Android: Use triggerANR for ANR detection
              if (CrashTestModule?.triggerANR) {
                CrashTestModule.triggerANR();
              } else {
                Alert.alert(
                  'Not Available',
                  'CrashTestModule is not available. Make sure you rebuilt the Android app.',
                );
              }
            }
          },
        },
      ],
    );
  };

  /**
   * Trigger slow frames simulation (iOS and Android)
   * Creates janky animations for ~5 seconds
   */
  const triggerSlowFrames = () => {
    Alert.alert(
      '⚠️ Warning',
      'This will cause janky UI for 5 seconds!\n\nSlow frames occur when frames take longer than 16.67ms to render (below 60 FPS).\n\nFrameMonitoringInstrumentation will detect and log these as `app_frames_rate` measurements.\n\nContinue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Start Slow Frames',
          style: 'destructive',
          onPress: () => {
            if (CrashTestModule?.triggerSlowFrames) {
              CrashTestModule.triggerSlowFrames();
            } else {
              Alert.alert(
                'Not Available',
                `CrashTestModule.triggerSlowFrames is not available. Make sure you rebuilt the ${Platform.OS === 'ios' ? 'iOS' : 'Android'} app.`,
              );
            }
          },
        },
      ],
    );
  };

  /**
   * Trigger heavy load with mixed performance issues (iOS and Android)
   * Combines continuous slow frames with periodic freezes
   */
  const triggerHeavyLoad = () => {
    Alert.alert(
      '⚠️ Warning',
      'This will cause severe performance issues for 10 seconds!\n\nCombines continuous slow frames with periodic freezes to simulate worst-case performance scenarios.\n\nBoth slow frames and frozen frames will be detected and logged.\n\nContinue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Start Heavy Load',
          style: 'destructive',
          onPress: () => {
            if (CrashTestModule?.triggerHeavyLoad) {
              CrashTestModule.triggerHeavyLoad();
            } else {
              Alert.alert(
                'Not Available',
                `CrashTestModule.triggerHeavyLoad is not available. Make sure you rebuilt the ${Platform.OS === 'ios' ? 'iOS' : 'Android'} app.`,
              );
            }
          },
        },
      ],
    );
  };

  const platformDescription =
    Platform.OS === 'ios'
      ? 'Test crash and performance detection features. Crashes are collected from previous sessions using PLCrashReporter. UI freezes and slow frames are detected in real-time by FrameMonitoringInstrumentation.'
      : "Test crash, ANR, and performance detection features. Crashes are collected from previous sessions using Android's ApplicationExitInfo API (Android 11+). ANRs, freezes, and slow frames are detected by Faro instrumentations.";

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Crash & Performance Demo</Text>
      <Text style={styles.description}>{platformDescription}</Text>

      {/* How It Works Section */}
      <View style={styles.infoBox}>
        <Text style={styles.infoTitle}>📖 How It Works</Text>
        <Text style={styles.infoText}>
          <Text style={{fontWeight: '600'}}>Crashes:{'\n'}</Text>
          1. Trigger a crash using the buttons below{'\n'}
          2. The app will terminate immediately{'\n'}
          3. Restart the app{'\n'}
          4. Faro automatically retrieves and sends the crash report{'\n'}
          5. Check Grafana for type="crash"{'\n\n'}
          <Text style={{fontWeight: '600'}}>Performance:{'\n'}</Text>
          1. Trigger freezes or slow frames{'\n'}
          2. Faro detects and logs in real-time{'\n'}
          3. Check Grafana for type="app_frozen_frame" or "app_frames_rate"
        </Text>
      </View>

      {/* Crash Triggers Section */}
      <Text style={styles.sectionTitle}>💥 Crash & Performance Triggers</Text>
      <View style={styles.buttonContainer}>
        <TouchableOpacity
          style={[styles.button, styles.crashButton]}
          onPress={triggerNativeCrash}
        >
          <Text style={styles.buttonText}>
            🔥 Native Crash{' '}
            {Platform.OS === 'ios' ? '(Swift/ObjC)' : '(Java/Kotlin)'}
          </Text>
          <Text style={styles.buttonSubtext}>
            {Platform.OS === 'ios'
              ? 'Triggers fatalError - app will close'
              : 'Throws RuntimeException - app will close'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.anrButton]}
          onPress={triggerANR}
        >
          <Text style={styles.buttonText}>
            🧊 {Platform.OS === 'ios' ? 'Trigger Freeze' : 'Trigger ANR'}
          </Text>
          <Text style={styles.buttonSubtext}>
            {Platform.OS === 'ios'
              ? 'Heavy computation - detects frozen frames'
              : 'Blocks main thread until system kills app'}
          </Text>
        </TouchableOpacity>

        {/* Additional Freeze Button for Android (non-fatal) */}
        {Platform.OS === 'android' && (
          <TouchableOpacity
            style={[styles.button, styles.performanceButton]}
            onPress={() => {
              Alert.alert(
                '⚠️ Warning',
                'This will freeze the app for 3 seconds!\n\nThe freeze will be detected by FrameMonitoringInstrumentation.\n\nContinue?',
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Freeze App',
                    style: 'destructive',
                    onPress: () => {
                      if (CrashTestModule?.triggerFreeze) {
                        CrashTestModule.triggerFreeze();
                      } else {
                        Alert.alert(
                          'Not Available',
                          'CrashTestModule is not available. Make sure you rebuilt the Android app.',
                        );
                      }
                    },
                  },
                ],
              );
            }}
          >
            <Text style={styles.buttonText}>❄️ Trigger Freeze (3s)</Text>
            <Text style={styles.buttonSubtext}>
              Blocks main thread - detects frozen frames
            </Text>
          </TouchableOpacity>
        )}

        {/* Performance Test Buttons - iOS and Android */}
        <TouchableOpacity
          style={[styles.button, styles.performanceButton]}
          onPress={triggerSlowFrames}
        >
          <Text style={styles.buttonText}>🐌 Trigger Slow Frames</Text>
          <Text style={styles.buttonSubtext}>
            Janky UI for 5s - detects frames below 60 FPS
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.performanceButton]}
          onPress={triggerHeavyLoad}
        >
          <Text style={styles.buttonText}>💣 Trigger Heavy Load</Text>
          <Text style={styles.buttonSubtext}>
            10s of continuous slow frames + periodic freezes
          </Text>
        </TouchableOpacity>

        {/* Debug: Check Frame Metrics */}
        {Platform.OS === 'ios' && (
          <>
            <TouchableOpacity
              style={[styles.button, styles.debugButton]}
              onPress={async () => {
                try {
                  const metrics =
                    await NativeModules.FaroReactNativeModule?.getFrameMetrics();
                  Alert.alert(
                    'Frame Metrics',
                    `Refresh Rate: ${metrics?.refreshRate || 0} FPS\n` +
                      `Slow Frames: ${metrics?.slowFrames || 0}\n` +
                      `Frozen Frames: ${metrics?.frozenFrames || 0}\n\n` +
                      `Note: Counters reset after each read.`,
                  );
                } catch (error) {
                  Alert.alert('Error', `Failed to get metrics: ${error}`);
                }
              }}
            >
              <Text style={styles.buttonText}>🔍 Check Frame Metrics</Text>
              <Text style={styles.buttonSubtext}>
                View current frozen frame count
              </Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* Requirements Note */}
      <View style={styles.noteBox}>
        <Text style={styles.noteTitle}>📱 Requirements</Text>
        <Text style={styles.noteText}>
          <Text style={{fontWeight: '600'}}>Crash Detection:{'\n'}</Text>
          {Platform.OS === 'ios'
            ? '• PLCrashReporter dependency (included via Podspec)\n'
            : '• Android 11+ (API 30+) for ApplicationExitInfo\n'}
          • enableCrashReporting: true in Faro config{'\n\n'}
          <Text style={{fontWeight: '600'}}>Performance Monitoring:{'\n'}</Text>
          {Platform.OS === 'ios'
            ? '• refreshRateVitals: true for frame detection\n'
            : '• anrTracking: true for ANR detection\n'}
          • Release build recommended for accurate data
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    padding: 20,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 8,
    color: '#333',
  },
  description: {
    fontSize: 14,
    marginBottom: 24,
    color: '#666',
    lineHeight: 20,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 12,
    color: '#333',
  },
  buttonContainer: {
    gap: 12,
    marginBottom: 16,
  },
  button: {
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  crashButton: {
    backgroundColor: '#dc3545',
  },
  anrButton: {
    backgroundColor: '#fd7e14',
  },
  performanceButton: {
    backgroundColor: '#6c757d',
  },
  debugButton: {
    backgroundColor: '#17a2b8',
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  buttonSubtext: {
    fontSize: 13,
    color: 'rgba(255, 255, 255, 0.8)',
    marginTop: 4,
  },
  infoBox: {
    backgroundColor: '#e7f3ff',
    padding: 16,
    borderRadius: 8,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#b3d7ff',
  },
  infoTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0056b3',
    marginBottom: 8,
  },
  infoText: {
    fontSize: 14,
    color: '#004085',
    lineHeight: 22,
  },
  noteBox: {
    backgroundColor: '#f8f9fa',
    padding: 16,
    borderRadius: 8,
    marginTop: 16,
    borderWidth: 1,
    borderColor: '#dee2e6',
  },
  noteTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#495057',
    marginBottom: 8,
  },
  noteText: {
    fontSize: 13,
    color: '#6c757d',
    lineHeight: 20,
  },
});

export default CrashDemoScreen;
