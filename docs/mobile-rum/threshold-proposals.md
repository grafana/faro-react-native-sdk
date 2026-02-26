# Threshold Proposals

← [Back to Mobile RUM Comparison](./index.md)

---

## CPU Usage

**Recommended Thresholds:**

| Level        | Threshold | Color     | Description                                 |
| ------------ | --------- | --------- | ------------------------------------------- |
| **Normal**   | 0-50%     | 🟢 Green  | Healthy CPU usage                           |
| **Warning**  | 50-75%    | 🟡 Yellow | Elevated CPU usage, monitor for issues      |
| **Critical** | 75-100%   | 🟠 Orange | High CPU usage, may impact performance      |
| **Severe**   | >100%     | 🔴 Red    | Multi-core saturation, performance degraded |

**Grafana Query Example:**

```promql
# Average CPU usage over time
avg(faro_measurement_values{type="app_cpu_usage"})

# High CPU alert (>75% for 5 minutes)
avg_over_time(faro_measurement_values{type="app_cpu_usage"}[5m]) > 75
```

---

### Memory Usage

**Recommended Thresholds:**

| Device Type               | Normal | Warning   | Critical  | Severe |
| ------------------------- | ------ | --------- | --------- | ------ |
| **Low-end** (<2GB RAM)    | <150MB | 150-250MB | 250-400MB | >400MB |
| **Mid-range** (2-4GB RAM) | <200MB | 200-350MB | 350-500MB | >500MB |
| **High-end** (>4GB RAM)   | <300MB | 300-500MB | 500-800MB | >800MB |

**Color Coding:**

- 🟢 Green: Normal
- 🟡 Yellow: Warning
- 🟠 Orange: Critical
- 🔴 Red: Severe (likely OOM crashes)

**Grafana Query Example:**

```promql
# Memory usage in MB
faro_measurement_values{type="app_memory"} / 1024

# Memory spike alert (>500MB)
faro_measurement_values{type="app_memory"} / 1024 > 500
```

---

### Refresh Rate & Frames

**Refresh Rate Thresholds:**

| Level         | FPS Range | Color     | Description                   |
| ------------- | --------- | --------- | ----------------------------- |
| **Excellent** | 58-60 FPS | 🟢 Green  | Smooth, optimal performance   |
| **Good**      | 50-57 FPS | 🟡 Yellow | Minor drops, still acceptable |
| **Poor**      | 30-49 FPS | 🟠 Orange | Noticeable jank, investigate  |
| **Critical**  | <30 FPS   | 🔴 Red    | Severe performance issues     |

**Slow Frame Events:**

| Level        | Events/30s | Color     | Description               |
| ------------ | ---------- | --------- | ------------------------- |
| **Normal**   | 0-2        | 🟢 Green  | Minimal jank              |
| **Warning**  | 3-5        | 🟡 Yellow | Some performance issues   |
| **Critical** | 6-10       | 🟠 Orange | Frequent jank             |
| **Severe**   | >10        | 🔴 Red    | Severe rendering problems |

**Frozen Frames:**

| Level        | Count/30s | Duration/30s | Color     | Description        |
| ------------ | --------- | ------------ | --------- | ------------------ |
| **Normal**   | 0         | 0ms          | 🟢 Green  | No freezes         |
| **Warning**  | 1-2       | <500ms       | 🟡 Yellow | Occasional freezes |
| **Critical** | 3-5       | 500-1500ms   | 🟠 Orange | Frequent freezes   |
| **Severe**   | >5        | >1500ms      | 🔴 Red    | App appears frozen |

**Grafana Query Examples:**

```promql
# Current refresh rate
faro_measurement_values{type="app_refresh_rate"}

# Slow frame events per minute
rate(faro_measurement_values{type="app_frames_rate"}[1m]) * 60

# Frozen frame duration per minute
rate(faro_measurement_values{type="app_frozen_frame", value="frozen_duration"}[1m]) * 60
```

---

### Startup Time

**Recommended Thresholds:**

| Level         | Cold Start | Color     | Description                 |
| ------------- | ---------- | --------- | --------------------------- |
| **Excellent** | <1.5s      | 🟢 Green  | Very fast startup           |
| **Good**      | 1.5-3s     | 🟡 Yellow | Acceptable startup time     |
| **Poor**      | 3-5s       | 🟠 Orange | Slow, needs optimization    |
| **Critical**  | >5s        | 🔴 Red    | Very slow, user frustration |

**Grafana Query Examples:**

```promql
# Average cold start time (coldStart=1)
avg(faro_measurement_values{type="app_startup", coldStart="1"})

# Average warm start time (coldStart=0)
avg(faro_measurement_values{type="app_startup", coldStart="0"})

# P95 cold start time
histogram_quantile(0.95, faro_measurement_values{type="app_startup", coldStart="1"})
```

---

### ANR Detection

**Thresholds:**

| Level        | Condition     | Color     | Description            |
| ------------ | ------------- | --------- | ---------------------- |
| **Normal**   | 0 ANRs        | 🟢 Green  | No blocking detected   |
| **Warning**  | 1-2 ANRs/hour | 🟡 Yellow | Occasional blocking    |
| **Critical** | 3-5 ANRs/hour | 🟠 Orange | Frequent blocking      |
| **Severe**   | >5 ANRs/hour  | 🔴 Red    | App often unresponsive |

**Grafana Query Example:**

```promql
# ANR count per hour
# Note: React Native sends ANR as type="crash" (CrashReporting) or default type (ANRInstrumentation).
# Flutter sends ANR as type="flutter_error". Adjust label filter based on your collector/backend.
sum(increase(faro_errors_total{type="ANR"}[1h]))
```

**ANR Alert Examples:**

```logql
# ANR spike: >3 in 1 hour (LogQL / Loki)
count_over_time({app_id="YOUR_APP_ID", kind="exception"} |~ "type=ANR" [1h]) > 3

# ANR rate alert: >5 per hour sustained
sum(rate({app_id="YOUR_APP_ID", kind="exception"} |~ "type=ANR" [$__interval])) * 3600 > 5
```

---

### Crash Alerts

**Recommended Thresholds:**

| Level        | Crashes/Hour | Color     | Description                      |
| ------------ | ------------ | --------- | -------------------------------- |
| **Normal**   | 0            | 🟢 Green  | No native crashes                |
| **Warning**  | 1            | 🟡 Yellow | Single crash, investigate        |
| **Critical** | 2-5          | 🟠 Orange | Multiple crashes, prioritize fix |
| **Severe**   | >5           | 🔴 Red    | Crash storm, immediate attention |

**Alert Examples:**

```logql
# Any crash in last hour (LogQL / Loki)
count_over_time({app_id="YOUR_APP_ID", kind="exception"} |~ "type=crash" [1h]) >= 1

# Crash spike: >2 crashes in 15 minutes
count_over_time({app_id="YOUR_APP_ID", kind="exception"} |~ "type=crash" [15m]) > 2

# Crash rate per 1000 sessions (if sessions metric available)
sum(rate({app_id="YOUR_APP_ID", kind="exception"} |~ "type=crash" [1h])) / sum(rate({app_id="YOUR_APP_ID", kind="session"}[1h])) * 1000 > 1
```

---

### Normal Errors (JS/Dart Runtime)

**Recommended Thresholds:**

Non-crash exceptions (uncaught JS errors, FlutterError, promise rejections):

| Level        | Errors/Hour | Color     | Description                  |
| ------------ | ----------- | --------- | ---------------------------- |
| **Normal**   | 0-5         | 🟢 Green  | Minimal runtime errors       |
| **Warning**  | 5-20        | 🟡 Yellow | Elevated errors, review logs |
| **Critical** | 20-100      | 🟠 Orange | High error rate, likely bug  |
| **Severe**   | >100        | 🔴 Red    | Error storm, urgent fix      |

**Alert Examples:**

```logql
# Count normal errors (for dashboards; excludes crash/ANR)
count_over_time(
  {app_id="YOUR_APP_ID", kind="exception"}
  !~ "type=crash|ANR"
  [$__auto]
)

# Normal error spike: >20 in 1 hour
count_over_time(
  {app_id="YOUR_APP_ID", kind="exception"}
  !~ "type=crash|ANR"
  [1h]
) > 20

# Short-window spike: >50 errors in 15 minutes (possible cascading failure)
count_over_time(
  {app_id="YOUR_APP_ID", kind="exception"}
  !~ "type=crash|ANR"
  [15m]
) > 50
```

---
