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
 * Crash Demo Screen
 *
 * Demonstrates crash reporting features:
 * - Native crashes (Java/Kotlin exceptions on Android, fatal errors on iOS)
 * - ANR simulation (blocking main thread)
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
   * Trigger an ANR by blocking the main thread
   * - Android: System will force-kill the app after ~5-10 seconds of unresponsiveness
   * - iOS: App becomes unresponsive (no official ANR mechanism)
   * This will freeze the app until the system kills it
   */
  const triggerANR = () => {
    const platformDetails =
      Platform.OS === 'ios'
        ? 'iOS does not have an official ANR mechanism, but the app will become unresponsive.'
        : 'The system will detect the unresponsive app and force-kill it. This records as REASON_ANR in ApplicationExitInfo.';

    Alert.alert(
      '⚠️ Warning',
      `This will freeze the app until the system kills it (~5-10 seconds).\n\n${platformDetails}\n\nContinue?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Trigger ANR',
          style: 'destructive',
          onPress: () => {
            if (CrashTestModule?.triggerANR) {
              CrashTestModule.triggerANR();
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

  const platformDescription =
    Platform.OS === 'ios'
      ? 'Test crash reporting features. Crashes are collected from previous sessions using PLCrashReporter.'
      : "Test crash reporting features. Crashes are collected from previous sessions using Android's ApplicationExitInfo API (Android 11+).";

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Crash Demo</Text>
      <Text style={styles.description}>{platformDescription}</Text>

      {/* How It Works Section */}
      <View style={styles.infoBox}>
        <Text style={styles.infoTitle}>📖 How It Works</Text>
        <Text style={styles.infoText}>
          1. Trigger a crash using the buttons below{'\n'}
          2. The app will terminate immediately{'\n'}
          3. Restart the app{'\n'}
          4. Faro automatically retrieves and sends the crash report{'\n'}
          5. Check Grafana for the crash with type="crash"
        </Text>
      </View>

      {/* Crash Triggers Section */}
      <Text style={styles.sectionTitle}>💥 Crash Triggers</Text>
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
          <Text style={styles.buttonText}>🧊 Trigger ANR</Text>
          <Text style={styles.buttonSubtext}>
            Blocks main thread until system kills app
          </Text>
        </TouchableOpacity>
      </View>

      {/* Requirements Note */}
      <View style={styles.noteBox}>
        <Text style={styles.noteTitle}>📱 Requirements</Text>
        <Text style={styles.noteText}>
          {Platform.OS === 'ios'
            ? '• PLCrashReporter dependency (included via Podspec)\n'
            : '• Android 11+ (API 30+) for ApplicationExitInfo\n'}
          • enableCrashReporting: true in Faro config{'\n'}
          • Release build recommended for accurate crash data
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
