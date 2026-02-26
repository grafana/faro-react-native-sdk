import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import {
  FaroErrorBoundary,
  trackUserAction,
  withFaroUserAction,
} from '@grafana/faro-react-native';

import type { RootStackParamList } from '../navigation/AppNavigator';

type Props = NativeStackScreenProps<RootStackParamList, 'UserActionsDemo'>;

const SimpleTapButton = withFaroUserAction(TouchableOpacity, 'simple_tap_no_http');
const FetchButton = withFaroUserAction(TouchableOpacity, 'tap_with_http_request');
const JsErrorButton = withFaroUserAction(TouchableOpacity, 'user_action_with_js_error');
const HttpErrorButton = withFaroUserAction(TouchableOpacity, 'user_action_with_http_error');

function ThrowingComponent(): never {
  throw new Error(
    'Intentional JS error for User Actions Demo - check error correlation in Grafana'
  );
}

export function UserActionsDemoScreen(_props: Props) {
  const [fetchStatus, setFetchStatus] = useState<string | null>(null);
  const [httpErrorStatus, setHttpErrorStatus] = useState<string | null>(null);
  const [manualActionCount, setManualActionCount] = useState(0);
  const [shouldThrowJsError, setShouldThrowJsError] = useState(false);
  const [jsErrorKey, setJsErrorKey] = useState(0);

  const handleSimpleTap = () => {
    Alert.alert(
      'User Action Tracked',
      'This tap was tracked as faro.user.action. Check Grafana Frontend Observability → Actions.',
      [{ text: 'OK' }]
    );
  };

  const handleTapWithFetch = async () => {
    setFetchStatus('Loading...');
    try {
      const response = await fetch('https://httpbin.org/delay/1');
      const ok = response.ok;
      setFetchStatus(ok ? 'Success' : 'Failed');
      if (!ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      setFetchStatus(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    } finally {
      setTimeout(() => setFetchStatus(null), 3000);
    }
  };

  const handleJsError = () => {
    // User action tracked by HOC; then child throws on next render - Faro captures and correlates
    setShouldThrowJsError(true);
  };

  const handleResetJsError = () => {
    setShouldThrowJsError(false);
    setJsErrorKey((k) => k + 1);
  };

  const handleHttpError = async () => {
    setHttpErrorStatus('Loading...');
    const url = 'https://httpstat.us/500';
    try {
      const response = await fetch(url);
      if (!response.ok) {
        setHttpErrorStatus(`HTTP Error: ${response.status}: ${response.statusText}`);
        // SDK sends faro.tracing.fetch event with status and action context → HTTP Errors column
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown';
      setHttpErrorStatus(`HTTP Error: ${errorMsg}`);
      // SDK sends faro.tracing.fetch event (status 0) with action context → HTTP Errors column
    } finally {
      setTimeout(() => setHttpErrorStatus(null), 3000);
    }
  };

  const handleManualTrack = () => {
    trackUserAction('manual_user_action_demo', {
      source: 'user_actions_demo_screen',
      count: String(manualActionCount + 1),
    });
    setManualActionCount((c) => c + 1);
    // Controller auto-ends after ~100ms
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>User Actions Demo</Text>
      <Text style={styles.description}>
        Tap the buttons below to send user actions to Grafana. Actions appear in
        Frontend Observability → Actions tab.
      </Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>1. Simple tap (no HTTP)</Text>
        <Text style={styles.sectionDescription}>
          HOC-wrapped button. Auto-ends after ~100ms. Sends faro.user.action.
        </Text>
        <SimpleTapButton
          style={[styles.button, styles.simpleTapButton]}
          onPress={handleSimpleTap}
        >
          <Text style={styles.buttonText}>Tap me (no fetch)</Text>
        </SimpleTapButton>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>2. Tap that triggers fetch</Text>
        <Text style={styles.sectionDescription}>
          User action + HTTP request. Controller waits for fetch to finish
          before ending (up to 10s).
        </Text>
        <FetchButton
          style={[styles.button, styles.fetchButton]}
          onPress={handleTapWithFetch}
        >
          <Text style={styles.buttonText}>Tap me (triggers fetch)</Text>
        </FetchButton>
        {fetchStatus && (
          <Text style={styles.statusText}>Status: {fetchStatus}</Text>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>3. User action + JS error</Text>
        <Text style={styles.sectionDescription}>
          Triggers a JavaScript error. In Grafana, the action and error are
          correlated so you can see which user action caused the error.
        </Text>
        <FaroErrorBoundary
          key={jsErrorKey}
          fallback={(error: Error, resetError: () => void) => (
            <View style={styles.errorFallback}>
              <Text style={styles.errorFallbackTitle}>❌ Error captured</Text>
              <Text style={styles.errorFallbackMessage}>{error.message}</Text>
              <TouchableOpacity
                style={styles.resetButton}
                onPress={() => {
                  resetError();
                  handleResetJsError();
                }}
              >
                <Text style={styles.resetButtonText}>Reset</Text>
              </TouchableOpacity>
            </View>
          )}
        >
          {shouldThrowJsError ? (
            <ThrowingComponent />
          ) : (
            <JsErrorButton
              style={[styles.button, styles.jsErrorButton]}
              onPress={handleJsError}
            >
              <Text style={styles.buttonText}>Tap me (throws JS error)</Text>
            </JsErrorButton>
          )}
        </FaroErrorBoundary>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>4. User action + HTTP error</Text>
        <Text style={styles.sectionDescription}>
          Fetches httpstat.us/500 (returns HTTP 500). SDK sends faro.tracing.fetch
          event with status and action context so it appears in HTTP Errors
          column. Correlates with the user action.
        </Text>
        <HttpErrorButton
          style={[styles.button, styles.httpErrorButton]}
          onPress={handleHttpError}
        >
          <Text style={styles.buttonText}>Tap me (triggers HTTP 500)</Text>
        </HttpErrorButton>
        {httpErrorStatus && (
          <Text style={styles.statusText}>{httpErrorStatus}</Text>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>5. Manual trackUserAction</Text>
        <Text style={styles.sectionDescription}>
          trackUserAction() with context. Auto-ends or call action?.end() when
          done.
        </Text>
        <TouchableOpacity
          style={[styles.button, styles.manualButton]}
          onPress={handleManualTrack}
        >
          <Text style={styles.buttonText}>
            Manual track ({manualActionCount} sent)
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.instructionsBox}>
        <Text style={styles.instructionsTitle}>How to verify in Grafana</Text>
        <Text style={styles.instructionsText}>
          • Open Grafana Cloud → Frontend Observability{'\n'}
          • Go to the Actions tab{'\n'}
          • Filter by app or session{'\n'}
          • Look for: simple_tap_no_http, tap_with_http_request,
          user_action_with_js_error, user_action_with_http_error,
          manual_user_action_demo{'\n'}
          • HTTP Errors column: from faro.tracing.fetch events (4xx/5xx/0) with
          action context
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
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 8,
    color: '#333',
  },
  description: {
    fontSize: 16,
    marginBottom: 24,
    color: '#666',
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
    marginBottom: 4,
  },
  sectionDescription: {
    fontSize: 14,
    color: '#666',
    marginBottom: 12,
  },
  button: {
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  simpleTapButton: {
    backgroundColor: '#10b981',
  },
  fetchButton: {
    backgroundColor: '#3b82f6',
  },
  jsErrorButton: {
    backgroundColor: '#dc2626',
  },
  httpErrorButton: {
    backgroundColor: '#ea580c',
  },
  manualButton: {
    backgroundColor: '#8b5cf6',
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  statusText: {
    fontSize: 14,
    color: '#666',
    marginTop: 8,
  },
  instructionsBox: {
    backgroundColor: '#f0f9ff',
    padding: 16,
    borderRadius: 10,
    marginTop: 16,
    borderWidth: 2,
    borderColor: '#3b82f6',
  },
  instructionsTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1e40af',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  instructionsText: {
    fontSize: 14,
    color: '#1e3a8a',
    lineHeight: 22,
  },
  errorFallback: {
    padding: 16,
    borderRadius: 8,
    backgroundColor: '#fef2f2',
    borderWidth: 2,
    borderColor: '#dc2626',
  },
  errorFallbackTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#b91c1c',
    marginBottom: 8,
  },
  errorFallbackMessage: {
    fontSize: 14,
    color: '#991b1b',
    marginBottom: 12,
  },
  resetButton: {
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#dc2626',
    alignSelf: 'flex-start',
  },
  resetButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
});
