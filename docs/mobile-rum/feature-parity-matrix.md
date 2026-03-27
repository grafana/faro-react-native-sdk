# Feature Parity Matrix

← [Back to Mobile RUM Comparison](./index.md)

---

## Complete Feature Comparison

| Feature                    | React Native                                            | Flutter                                     | Notes                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Performance Monitoring** |
| CPU Usage                  | ✅ Per-process (iOS)                                    | ⚠️ System-wide (iOS)                        | RN more accurate                                                                                                                                                      |
| Memory Usage               | ✅ phys_footprint (iOS)                                 | ⚠️ resident_size (iOS)                      | RN uses Apple-recommended metric                                                                                                                                      |
| Refresh Rate               | ✅ With ProMotion                                       | ✅ With ProMotion                           | Both support high-refresh displays                                                                                                                                    |
| Slow Frames                | ✅ Event-based grouping (iOS & Android)                 | ✅ Count-based (Android only)               | RN groups consecutive frames                                                                                                                                          |
| Frozen Frames              | ✅ Count + duration (iOS & Android)                     | ✅ Count only (Android only)                | RN tracks duration                                                                                                                                                    |
| Frame Monitoring Config    | ✅ Extensive options                                    | ❌ Minimal                                  | RN more configurable                                                                                                                                                  |
| **Startup Metrics**        |
| Cold Start Time            | ✅ iOS & Android                                        | ✅ iOS & Android                            | Identical implementation                                                                                                                                              |
| Warm Start Time            | ✅ iOS & Android                                        | ✅ iOS & Android                            | Both via AppState/lifecycle                                                                                                                                           |
| **Error & Crash**          |
| JavaScript/Dart Errors     | ✅ ErrorUtils patch                                     | ✅ FlutterError.onError                     | Platform-specific                                                                                                                                                     |
| Promise Rejections         | ✅ Tracked                                              | ✅ Tracked                                  | Both handle unhandled rejections                                                                                                                                      |
| Crash Reporting (iOS)      | ✅ PLCrashReporter                                      | ✅ PLCrashReporter                          | Same implementation                                                                                                                                                   |
| Crash Reporting (Android)  | ✅ ApplicationExitInfo                                  | ✅ ApplicationExitInfo                      | Same (API 30+)                                                                                                                                                        |
| ANR Detection              | ✅ Android only                                         | ✅ Android only                             | Watchdog-based                                                                                                                                                        |
| Error Deduplication        | ✅ Fingerprint (message+stack), 5s window, configurable | ❌ None                                     | RN: message+stack fingerprint, time window                                                                                                                            |
| **Network Monitoring**     |
| Fetch API                  | ✅ Automatic                                            | N/A (no fetch in Flutter)                   | RN: faro.tracing.fetch events (Web SDK format)                                                                                                                        |
| XMLHttpRequest / axios     | ✅ Automatic                                            | N/A                                         | RN: both fetch and XHR tracked                                                                                                                                        |
| Request/Response Size      | ✅ Tracked                                              | ✅ Tracked                                  | Both capture sizes                                                                                                                                                    |
| URL Filtering              | ✅ RegExp array                                         | ✅ String array                             | Different filter types                                                                                                                                                |
| **Session Management**     |
| Session Tracking           | ✅ AsyncStorage                                         | ✅ SharedPreferences                        | Platform storage                                                                                                                                                      |
| Session Persistence        | ✅ Survives restarts                                    | ✅ Survives restarts                        | Both persist sessions                                                                                                                                                 |
| Session Timeout            | ✅ 4h max / 15min inactivity                            | ❌ None (app process lifetime)              | RN: configurable; Flutter: no timeout                                                                                                                                 |
| Session Attributes         | ✅ Auto-collected                                       | ✅ Auto-collected                           | Device, OS, version                                                                                                                                                   |
| **User Actions**           |
| User Action Tracking       | ✅ HOC + manual API                                     | ✅ FaroUserInteractionWidget + manual spans | RN: withFaroUserAction HOC + trackUserAction(); Flutter: wrap app with FaroUserInteractionWidget, pushEvent('user_interaction'), Faro().startSpan('user_action', ...) |
| HTTP Correlation           | ✅ Automatic via trace + W3C Trace Context              | ✅ Automatic via trace + W3C Trace Context  | Both: trace context propagation + W3C Trace Context (traceparent/tracestate) on HTTP requests                                                                         |
| **Navigation**             |
| React Navigation           | ✅ Built-in support                                     | N/A                                         | RN-specific                                                                                                                                                           |
| Screen Tracking            | ✅ ViewInstrumentation                                  | ✅ Route tracking                           | Platform-specific                                                                                                                                                     |
| **Platform Support**       |
| iOS                        | ✅ 13.4+                                                | ✅ 11.0+                                    | RN: newer minimum; Flutter: iOS 11+ (faro.podspec)                                                                                                                    |
| Android                    | ✅ API 21+                                              | ✅ API 19+                                  | RN: API 21; Flutter: minSdkVersion 19 (build.gradle)                                                                                                                  |
| **Configuration**          |
| Type Safety                | ✅ TypeScript                                           | ✅ Dart                                     | Strong typing both                                                                                                                                                    |
| Default Config             | ✅ Sensible defaults                                    | ✅ Sensible defaults                        | Both production-ready                                                                                                                                                 |
| Extensibility              | ✅ Custom instrumentations                              | ✅ Custom integrations                      | Both extensible                                                                                                                                                       |

---

## Missing Features & Roadmap

### React Native SDK - Planned Features

#### **High Priority**

1. **Web Vitals Equivalent for Mobile**
   - Time to First Contentful Paint (FCP)
   - Time to Interactive (TTI)
   - First Input Delay (FID)

2. **Better Error Source Maps Support**
   - Symbolication for production builds
   - Source map upload tooling
   - Better stack trace resolution

3. **Network Request Body Sanitization**
   - Remove sensitive data from request bodies
   - Configurable sanitization rules
   - PII detection and filtering

4. **Custom User Actions API**
   - Enhanced manual tracking
   - Action composition and nesting
   - Better correlation with business metrics

#### **Medium Priority**

5. **iOS ANR Detection**
   - Main thread watchdog for iOS
   - Different from Android implementation
   - iOS-specific hangs detection

6. **Battery Usage Tracking**
   - Monitor battery drain
   - Correlate with performance metrics
   - iOS: Use IOKit, Android: BatteryManager

7. **Network Connection Quality**
   - Track connection type (WiFi, 4G, 5G)
   - Monitor connection changes
   - Correlate performance with network quality

8. **Disk Usage Monitoring**
   - Track available storage
   - Monitor cache size growth
   - Alert on low storage conditions

9. **React Native Hermes Profiling**
   - Better Hermes engine integration
   - JavaScript heap profiling
   - Hermes-specific metrics

#### **Low Priority / Future**

10. **Offline Queue Management**
    - Better offline telemetry storage
    - Configurable queue limits
    - Smart retry logic

11. **A/B Testing Integration**
    - Tag sessions with experiment variants
    - Compare metrics across variants
    - Built-in A/B test support

12. **Custom Metrics API**
    - User-defined measurements
    - Business metric tracking
    - Custom aggregations

---

### Flutter SDK - Areas to Watch

Based on the comparison, Flutter SDK may want to consider:

1. **Improve iOS CPU Monitoring**
   - Switch from system-wide to per-process calculation
   - Match React Native's accurate implementation

2. **Use Apple-Recommended Memory Metric**
   - Switch from `resident_size` to `phys_footprint`
   - Better correlation with Xcode tools

3. **Improve Slow Frame Detection (Android)**
   - Consider event-based grouping (like RN) instead of raw count
   - Filter noise with minimum duration threshold

4. **Improve Frozen Frame Detection**
   - Add `frozen_duration` alongside count (Android)
   - iOS: Add frozen/slow frame support (currently Android only)

5. **Expand Frame Monitoring Configuration**
   - Make thresholds configurable
   - Allow customization per use case

---

## Best Practices

### General Recommendations

1. **Start with Defaults**
   - Both SDKs have sensible defaults
   - Enable features gradually
   - Monitor impact on app performance

2. **Monitor in Staging First**
   - Test telemetry volume
   - Verify data accuracy
   - Check performance impact

3. **Use Feature Flags**
   - Control monitoring features remotely
   - Gradual rollout to users
   - Quick disable if issues arise

4. **Set Up Alerts**
   - Use threshold recommendations
   - Alert on anomalies
   - Page on critical issues

5. **Correlate Metrics**
   - High CPU + High memory = investigate
   - Slow frames + Network issues = poor UX
   - Crashes + Specific device = hardware issue

### SDK-Specific Recommendations

#### **React Native**

- Enable `refreshRateVitals` only when investigating UI performance
- Use `frameMonitoringOptions` to tune detection sensitivity
- Monitor slow frame events (not individual frames) for better signal
- Keep `fetchVitalsInterval` at 30s unless you need higher resolution

#### **Flutter**

- Be aware of iOS CPU measurement limitations
- Consider memory unit differences between iOS/Android
- Basic refresh rate monitoring may be sufficient for most apps

---

## Conclusion

Both Faro React Native and Flutter SDKs provide comprehensive mobile RUM capabilities with strong feature parity. Key takeaways:

**React Native SDK Strengths:**

- More accurate iOS CPU monitoring (per-process)
- Apple-recommended memory metric (`phys_footprint`)
- Advanced frame monitoring with slow/frozen frame detection
- Highly configurable frame monitoring options
- Event-based jank detection filters noise effectively

**Flutter SDK Strengths:**

- Mature, production-tested implementation
- Clean Dart API with strong typing
- Good documentation and examples
- Works well for basic monitoring needs

**Recommendation:**

- **For new projects**: Choose based on your app framework (React Native vs Flutter)
- **For advanced frame monitoring**: React Native SDK has more features
- **For basic monitoring**: Both SDKs are excellent choices
- **For maximum accuracy**: React Native iOS CPU monitoring is superior

Both SDKs continue to evolve, and feature parity improvements are ongoing. Check the latest documentation for updates.

---

## Additional Resources

- [Faro React Native SDK GitHub](https://github.com/grafana/faro-react-native-sdk)
- [Faro Flutter SDK GitHub](https://github.com/grafana/faro-flutter-sdk)
- [Grafana Faro Documentation](https://grafana.com/docs/grafana-cloud/monitor-applications/frontend-observability/)
- [React Native SDK README](../../packages/react-native/README.md)
- [Contributing Guidelines](../../CONTRIBUTING.md)

---

**Document Version:** 1.1.0  
**Last Updated:** 2025-02-20  
**Maintained by:** Grafana Faro Team

**Changelog (v1.1.0):** Updated React Native config examples to flag-based model using `makeRNConfig`; added `enableTransports`, `enableTracing`, `consoleCaptureOptions`, `userActionsOptions`; removed manual `getRNInstrumentations` usage.
