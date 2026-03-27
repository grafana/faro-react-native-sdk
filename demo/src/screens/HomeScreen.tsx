import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { withFaroUserAction } from '@grafana/faro-react-native';

import { useFaroUser } from '../hooks/useFaroUser';
import type { RootStackParamList } from '../navigation/AppNavigator';

const ShowcaseButton = withFaroUserAction(TouchableOpacity, 'navigate_showcase');
const UserActionsButton = withFaroUserAction(TouchableOpacity, 'navigate_user_actions_demo');
const ErrorDemoButton = withFaroUserAction(TouchableOpacity, 'navigate_error_demo');
const CrashDemoButton = withFaroUserAction(TouchableOpacity, 'navigate_crash_demo');
const PerformanceDemoButton = withFaroUserAction(TouchableOpacity, 'navigate_performance_demo');
const ConsoleTestButton = withFaroUserAction(TouchableOpacity, 'navigate_console_test');
const DeviceInfoButton = withFaroUserAction(TouchableOpacity, 'navigate_device_info');
const TracingDemoButton = withFaroUserAction(TouchableOpacity, 'navigate_tracing_demo');
const AboutButton = withFaroUserAction(TouchableOpacity, 'navigate_about');

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

export function HomeScreen({ navigation }: Props) {
  const currentUser = useFaroUser();

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Faro React Native Demo</Text>
      <Text style={styles.subtitle}>
        Welcome to the Grafana Faro React Native SDK Demo
      </Text>

      {currentUser && (
        <View style={styles.userInfoBox}>
          <Text style={styles.userInfoTitle}>👤 Current User</Text>
          <Text style={styles.userInfoText}>
            {currentUser.username} ({currentUser.email})
          </Text>
          <Text style={styles.userInfoDetails}>
            Role: {currentUser.attributes?.role} • Plan:{' '}
            {currentUser.attributes?.plan}
          </Text>
        </View>
      )}

      <View style={styles.buttonContainer}>
        <ShowcaseButton
          style={[styles.button, styles.showcaseButton]}
          onPress={() => navigation.navigate('Showcase')}
        >
          <Text style={styles.buttonText}>✨ SDK Showcase</Text>
          <Text style={styles.buttonDescription}>
            Demo all features with different user profiles - Perfect for
            presentations!
          </Text>
        </ShowcaseButton>

        <UserActionsButton
          style={[styles.button, styles.userActionsButton]}
          onPress={() => navigation.navigate('UserActionsDemo')}
        >
          <Text style={styles.buttonText}>🎯 User Actions Demo</Text>
          <Text style={styles.buttonDescription}>
            Test user action tracking - see actions in Grafana
          </Text>
        </UserActionsButton>

        <ErrorDemoButton
          style={[styles.button, styles.errorButton]}
          onPress={() => navigation.navigate('ErrorDemo')}
        >
          <Text style={styles.buttonText}>❌ Error Demo</Text>
          <Text style={styles.buttonDescription}>
            Test error capture and reporting
          </Text>
        </ErrorDemoButton>

        <CrashDemoButton
          style={[styles.button, styles.crashButton]}
          onPress={() => navigation.navigate('CrashDemo')}
        >
          <Text style={styles.buttonText}>💥 Crash Demo</Text>
          <Text style={styles.buttonDescription}>
            Test native crashes and ANR (Android 11+)
          </Text>
        </CrashDemoButton>

        <PerformanceDemoButton
          style={[styles.button, styles.performanceButton]}
          onPress={() => navigation.navigate('PerformanceDemo')}
        >
          <Text style={styles.buttonText}>⚡ Performance Demo</Text>
          <Text style={styles.buttonDescription}>
            Test performance monitoring
          </Text>
        </PerformanceDemoButton>

        <ConsoleTestButton
          style={[styles.button, styles.consoleTestButton]}
          onPress={() => navigation.navigate('ConsoleTest')}
        >
          <Text style={styles.buttonText}>🔧 Console Tests</Text>
          <Text style={styles.buttonDescription}>
            Test advanced console instrumentation features
          </Text>
        </ConsoleTestButton>

        <DeviceInfoButton
          style={[styles.button, styles.deviceInfoButton]}
          onPress={() => navigation.navigate('DeviceInfo')}
        >
          <Text style={styles.buttonText}>📱 Device Info</Text>
          <Text style={styles.buttonDescription}>
            View enhanced device metadata collection
          </Text>
        </DeviceInfoButton>

        <TracingDemoButton
          style={[styles.button, styles.tracingButton]}
          onPress={() => navigation.navigate('TracingDemo')}
        >
          <Text style={styles.buttonText}>🔍 Tracing Demo</Text>
          <Text style={styles.buttonDescription}>
            Test distributed tracing with trace ID display
          </Text>
        </TracingDemoButton>

        <AboutButton
          style={[styles.button, styles.aboutButton]}
          onPress={() => navigation.navigate('About')}
        >
          <Text style={styles.buttonText}>ℹ️ About</Text>
          <Text style={styles.buttonDescription}>
            About this demo application
          </Text>
        </AboutButton>
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
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 8,
    color: '#333',
  },
  subtitle: {
    fontSize: 16,
    marginBottom: 20,
    color: '#666',
  },
  userInfoBox: {
    backgroundColor: '#f0f9ff',
    padding: 16,
    borderRadius: 10,
    marginBottom: 20,
    borderWidth: 2,
    borderColor: '#3b82f6',
  },
  userInfoTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1e40af',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  userInfoText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1e3a8a',
    marginBottom: 4,
  },
  userInfoDetails: {
    fontSize: 13,
    color: '#3b82f6',
  },
  buttonContainer: {
    gap: 16,
  },
  button: {
    backgroundColor: '#FF5F00',
    padding: 20,
    borderRadius: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  showcaseButton: {
    backgroundColor: '#28a745',
  },
  userActionsButton: {
    backgroundColor: '#06b6d4',
  },
  errorButton: {
    backgroundColor: '#dc3545',
  },
  crashButton: {
    backgroundColor: '#ff4757',
  },
  performanceButton: {
    backgroundColor: '#007bff',
  },
  consoleTestButton: {
    backgroundColor: '#6f42c1',
  },
  deviceInfoButton: {
    backgroundColor: '#fd7e14',
  },
  tracingButton: {
    backgroundColor: '#20c997',
  },
  aboutButton: {
    backgroundColor: '#6c757d',
  },
  buttonText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#fff',
    marginBottom: 4,
  },
  buttonDescription: {
    fontSize: 14,
    color: '#ffe6d5',
  },
});
