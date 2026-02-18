import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { faro } from '@grafana/faro-react-native';

import { PerformanceMetricsCard } from '../components/PerformanceMetricsCard';

/**
 * Device Info Screen
 * Displays live performance metrics and device metadata sent as session attributes
 */
export default function DeviceInfoScreen() {
  // Get session attributes from Faro
  const metasValue = faro?.metas?.value as Record<string, unknown> | undefined;
  const sessionMeta = (metasValue?.session as Record<string, unknown>) || {};
  const sessionAttributes =
    (sessionMeta.attributes as Record<string, unknown>) || {};

  const renderMetaField = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    return (
      <View style={styles.metaRow} key={label}>
        <Text style={styles.metaLabel}>{label}:</Text>
        <Text style={styles.metaValue}>{String(value)}</Text>
      </View>
    );
  };

  const formatBytes = (bytes: string | undefined): string => {
    if (!bytes) return 'N/A';
    const num = parseInt(bytes, 10);
    if (isNaN(num)) return 'N/A';
    const gb = (num / 1024 / 1024 / 1024).toFixed(2);
    const mb = (num / 1024 / 1024).toFixed(0);
    return num > 1024 * 1024 * 1024 ? `${gb} GB` : `${mb} MB`;
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Device Information</Text>
        <Text style={styles.description}>
          All metadata is automatically sent as session attributes with every
          telemetry event. No browser or page meta fields - mobile-first
          approach! 🚀
        </Text>

        {/* Live Performance Metrics */}
        <PerformanceMetricsCard title="⚡ Live Performance" />

        {/* System Information */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>📱 System Information</Text>
          {renderMetaField('OS', sessionAttributes.device_os)}
          {renderMetaField('OS Version', sessionAttributes.device_os_version)}
          {renderMetaField('OS Detail', sessionAttributes.device_os_detail)}
          {renderMetaField('SDK Version', sessionAttributes.faro_sdk_version)}
          {renderMetaField(
            'React Native',
            sessionAttributes.react_native_version,
          )}
        </View>

        {/* Device Details */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🔧 Device Details</Text>
          {renderMetaField(
            'Manufacturer',
            sessionAttributes.device_manufacturer,
          )}
          {renderMetaField('Brand', sessionAttributes.device_brand)}
          {renderMetaField('Model', sessionAttributes.device_model)}
          {renderMetaField('Model Name', sessionAttributes.device_model_name)}
          {renderMetaField('Device Type', sessionAttributes.device_type)}
          {renderMetaField('Is Physical', sessionAttributes.device_is_physical)}
          {renderMetaField(
            'Device ID',
            String(sessionAttributes.device_id).substring(0, 8) + '...',
          )}
        </View>

        {/* Memory & Resources */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>💾 Memory & Resources</Text>
          {renderMetaField(
            'Total Memory',
            formatBytes(sessionAttributes.device_memory_total as string),
          )}
          {renderMetaField(
            'Used Memory',
            formatBytes(sessionAttributes.device_memory_used as string),
          )}
          {sessionAttributes.device_memory_total &&
          sessionAttributes.device_memory_used &&
          typeof sessionAttributes.device_memory_total === 'string' &&
          typeof sessionAttributes.device_memory_used === 'string' ? (
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Memory Usage:</Text>
              <Text style={styles.metaValue}>
                {(
                  (parseInt(sessionAttributes.device_memory_used, 10) /
                    parseInt(sessionAttributes.device_memory_total, 10)) *
                  100
                ).toFixed(1)}
                %
              </Text>
            </View>
          ) : null}
        </View>

        {/* Battery & Power */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🔋 Battery & Power</Text>
          {sessionAttributes.device_battery_level ? (
            renderMetaField(
              'Battery Level',
              `${sessionAttributes.device_battery_level}%`,
            )
          ) : (
            <Text style={styles.loading}>Battery info not available</Text>
          )}
          {renderMetaField('Is Charging', sessionAttributes.device_is_charging)}
          {renderMetaField(
            'Low Power Mode',
            sessionAttributes.device_low_power_mode,
          )}
        </View>

        {/* Network & Connectivity */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>📡 Network & Connectivity</Text>
          {sessionAttributes.device_carrier ? (
            renderMetaField('Carrier', sessionAttributes.device_carrier)
          ) : (
            <Text style={styles.loading}>Carrier info not available</Text>
          )}
        </View>

        {/* Instructions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>💡 Usage in Grafana Cloud</Text>
          <Text style={styles.instructions}>
            All metadata is sent as session attributes (device_* prefix)
            matching Flutter SDK convention.
            {'\n\n'}
            Query examples in Grafana:
            {'\n\n'}
            {`{service_name="MyApp", device_manufacturer="samsung"}`}
            {'\n'}
            {`{service_name="MyApp", device_os="Android", device_os_version="14"}`}
            {'\n'}
            {`{service_name="MyApp", device_is_physical="false"}`}
            {'\n'}
            {`{service_name="MyApp"} | device_battery_level <= "20"`}
            {'\n\n'}
            No browser_ or page_ fields - clean mobile-first architecture! ✨
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  content: {
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 10,
    color: '#333',
  },
  description: {
    fontSize: 14,
    color: '#666',
    marginBottom: 20,
    lineHeight: 20,
  },
  section: {
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
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 15,
    color: '#333',
  },
  metaRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  metaLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
    width: 140,
  },
  metaValue: {
    fontSize: 14,
    color: '#333',
    flex: 1,
    flexWrap: 'wrap',
  },
  error: {
    fontSize: 14,
    color: '#ff6b6b',
    fontStyle: 'italic',
  },
  loading: {
    fontSize: 14,
    color: '#999',
    fontStyle: 'italic',
  },
  buttonContainer: {
    marginBottom: 20,
  },
  instructions: {
    fontSize: 12,
    color: '#666',
    lineHeight: 18,
    fontFamily: 'monospace',
  },
});
