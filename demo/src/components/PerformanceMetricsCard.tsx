import React, { useEffect, useState } from 'react';
import { NativeModules, StyleSheet, Text, View } from 'react-native';

import { faro } from '@grafana/faro-react-native';
import type { ReactNativeConfig } from '@grafana/faro-react-native';

const { FaroReactNativeModule } = NativeModules;

const DEFAULT_FETCH_VITALS_INTERVAL_MS = 30000;

interface PerformanceMetricsCardProps {
  /** Optional title for the metrics section */
  title?: string;
  /** Optional subtitle/description */
  subtitle?: string;
  /** Update interval in milliseconds (default: faro.config.fetchVitalsInterval) */
  updateInterval?: number;
}

/**
 * Shared component for displaying live CPU and memory metrics
 * Updates automatically at the specified interval, aligned with Faro vitals collection
 */
export function PerformanceMetricsCard({
  title = '⚡ Live Performance Metrics',
  subtitle,
  updateInterval,
}: PerformanceMetricsCardProps) {
  const config = faro?.config as ReactNativeConfig | undefined;
  const intervalMs =
    updateInterval ??
    config?.fetchVitalsInterval ??
    DEFAULT_FETCH_VITALS_INTERVAL_MS;
  const displaySubtitle =
    subtitle ?? `Updates every ${intervalMs / 1000} seconds`;
  const [cpuUsage, setCpuUsage] = useState<number | null>(null);
  const [memoryUsage, setMemoryUsage] = useState<number | null>(null);

  useEffect(() => {
    let stopped = false;
    let previous: { cpuTimeMs: number; elapsedMs: number } | undefined;
    let pending = false;
    const update = async () => {
      if (!FaroReactNativeModule?.getPerformanceSnapshot || pending) {
        return;
      }
      pending = true;
      try {
        const snapshot = await FaroReactNativeModule.getPerformanceSnapshot(
          true,
          true,
        );
        if (stopped) {
          return;
        }
        const elapsed = previous ? snapshot.elapsedMs - previous.elapsedMs : 0;
        const cpu =
          previous && elapsed > 0 && snapshot.cpuTimeMs != null
            ? (100 * (snapshot.cpuTimeMs - previous.cpuTimeMs)) /
              (elapsed * snapshot.logicalCount)
            : null;
        setCpuUsage(
          cpu != null && Number.isFinite(cpu) && cpu >= 0 && cpu <= 100
            ? cpu
            : null,
        );
        setMemoryUsage(snapshot.memoryBytes);
        previous = snapshot.cpuTimeMs == null ? undefined : snapshot;
      } catch (err) {
        console.error('Failed to get performance metrics', err);
      } finally {
        pending = false;
      }
    };
    void update();
    const interval = setInterval(() => {
      void update();
    }, intervalMs);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [intervalMs]);

  return (
    <View style={styles.container}>
      {title && <Text style={styles.title}>{title}</Text>}
      <View style={styles.performanceGrid}>
        <View style={styles.performanceCard}>
          <Text style={styles.performanceLabel}>
            App CPU (% of available CPU time)
          </Text>
          <Text style={styles.performanceValue}>
            {cpuUsage !== null && cpuUsage >= 0
              ? `${cpuUsage.toFixed(1)}%`
              : 'Calculating...'}
          </Text>
        </View>
        <View style={styles.performanceCard}>
          <Text style={styles.performanceLabel}>Memory Usage</Text>
          <Text style={styles.performanceValue}>
            {memoryUsage !== null && memoryUsage > 0
              ? `${(memoryUsage / 1048576).toFixed(1)} MB`
              : 'Calculating...'}
          </Text>
        </View>
      </View>
      {displaySubtitle && (
        <Text style={styles.subtitle}>{displaySubtitle}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 20,
    backgroundColor: '#fff',
    padding: 15,
    borderRadius: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 15,
    color: '#333',
  },
  performanceGrid: {
    flexDirection: 'row',
    gap: 12,
  },
  performanceCard: {
    flex: 1,
    backgroundColor: '#f0f9ff',
    padding: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#3b82f6',
    alignItems: 'center',
  },
  performanceLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1e40af',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  performanceValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#3b82f6',
  },
  subtitle: {
    fontSize: 12,
    color: '#666',
    marginTop: 12,
    textAlign: 'center',
  },
});
