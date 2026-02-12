import React, { useState } from 'react';
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
 * - Checking for crash reports from previous sessions
 *
 * IMPORTANT: Crash reports are collected from PREVIOUS sessions.
 * When a crash occurs, the app terminates immediately.
 * On the next app launch, CrashReportingInstrumentation retrieves
 * the crash data via:
 * - Android: ApplicationExitInfo API (Android 11+)
 * - iOS: PLCrashReporter
 *
 * NOTE: CrashTestModule is a demo-only native module. It is NOT part
 * of the Faro SDK - crash triggers should never be in production code.
 */
export function CrashDemoScreen() {
  const [crashReports, setCrashReports] = useState<string[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // FaroReactNativeModule is from the SDK (for getCrashReport)
  // CrashTestModule is demo-only (for triggering test crashes)
  const { FaroReactNativeModule, CrashTestModule } = NativeModules;

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
   * - Android: May trigger ANR dialog
   * - iOS: App becomes unresponsive (no official ANR mechanism)
   * This will freeze the app for 10 seconds
   */
  const triggerANR = () => {
    const platformDetails =
      Platform.OS === 'ios'
        ? 'iOS does not have an official ANR mechanism, but the app will become unresponsive.'
        : 'The system may show an "App isn\'t responding" dialog.';

    Alert.alert(
      '⚠️ Warning',
      `This will freeze the app for 10 seconds.\n\n${platformDetails}\n\nContinue?`,
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

  /**
   * Check for crash reports from previous sessions
   */
  const checkCrashReports = async () => {
    setIsLoading(true);
    setCrashReports(null);

    try {
      if (FaroReactNativeModule?.getCrashReport) {
        const reports = await FaroReactNativeModule.getCrashReport();
        setCrashReports(reports);

        if (!reports || reports.length === 0) {
          const platformNote =
            Platform.OS === 'ios'
              ? 'Crash reports are captured by PLCrashReporter and are available after a crash occurred.'
              : 'Crash reports require Android 11+ and are only available after an actual crash occurred.';
          Alert.alert(
            'No Crash Reports',
            `No crash reports found from previous sessions.\n\nNote: ${platformNote}`,
          );
        }
      } else {
        Alert.alert(
          'Not Available',
          'Crash report retrieval is not available on this platform or build.',
        );
      }
    } catch (error) {
      Alert.alert('Error', `Failed to get crash reports: ${error}`);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Format crash report JSON for display
   */
  const formatCrashReport = (reportJson: string): string => {
    try {
      const report = JSON.parse(reportJson);
      let formatted =
        `Reason: ${report.reason}\n` +
        `Timestamp: ${new Date(report.timestamp).toLocaleString()}\n` +
        `Status: ${report.status}\n` +
        `Process: ${report.processName}\n` +
        `PID: ${report.pid}\n`;

      // Show crashed session ID if available (for session correlation)
      if (report.crashedSessionId) {
        formatted += `Crashed Session ID: ${report.crashedSessionId}\n`;
      }

      if (report.description) {
        formatted += `Description: ${report.description}\n`;
      }

      // iOS-specific: show signal info
      if (report.signal) {
        formatted += `Signal: ${report.signal}\n`;
      }

      // iOS-specific: show incident ID
      if (report.incidentId) {
        formatted += `Incident ID: ${report.incidentId}\n`;
      }

      if (report.trace) {
        formatted += `\nTrace:\n${report.trace.substring(0, 500)}...`;
      }

      return formatted;
    } catch {
      return reportJson;
    }
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
            Blocks main thread for 10 seconds
          </Text>
        </TouchableOpacity>
      </View>

      {/* Check Reports Section */}
      <Text style={styles.sectionTitle}>📋 Previous Crash Reports</Text>
      <View style={styles.buttonContainer}>
        <TouchableOpacity
          style={[styles.button, styles.checkButton]}
          onPress={checkCrashReports}
          disabled={isLoading}
        >
          <Text style={styles.buttonText}>
            {isLoading ? '⏳ Loading...' : '🔍 Check for Crash Reports'}
          </Text>
          <Text style={styles.buttonSubtext}>
            Retrieves crashes from previous sessions
          </Text>
        </TouchableOpacity>
      </View>

      {/* Display Crash Reports */}
      {crashReports && crashReports.length > 0 && (
        <View style={styles.reportsContainer}>
          <Text style={styles.reportsTitle}>
            Found {crashReports.length} crash report(s):
          </Text>
          {crashReports.map((report, index) => (
            <View key={index} style={styles.reportCard}>
              <Text style={styles.reportText}>
                {formatCrashReport(report)}
              </Text>
            </View>
          ))}
        </View>
      )}

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
  checkButton: {
    backgroundColor: '#007bff',
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
  reportsContainer: {
    marginTop: 16,
  },
  reportsTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#28a745',
    marginBottom: 12,
  },
  reportCard: {
    backgroundColor: '#f8f9fa',
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#dee2e6',
  },
  reportText: {
    fontSize: 12,
    color: '#333',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 18,
  },
});

export default CrashDemoScreen;
