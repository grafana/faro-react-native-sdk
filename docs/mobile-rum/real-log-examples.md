# Real Log Examples

← [Back to Mobile RUM Comparison](./index.md)

---

Log examples below use the **Grafana Alloy faro receiver** log format (logfmt). Replace `app_id="YOUR_APP_ID"` with your application ID in Grafana Cloud or self-hosted setup.

---

### Startup Time

```text
timestamp=2026-02-23T10:57:02.991Z kind=measurement level=info type=app_startup total_duration_ms=3840 value_total_duration_ms=3840 value_coldStart=1 sdk_name=@grafana/faro-react-native sdk_version=2.2.3 app_name=react-native-sdk-demo app_version=1.0.0 session_id=xy2Gb9cmSW view_name=unknown
```

**Query:**

```logql
{app_id="YOUR_APP_ID", kind="measurement"} | logfmt | type="app_startup"
```

**Average cold start duration:**

```logql
avg_over_time({app_id="YOUR_APP_ID", kind="measurement"} | logfmt | type="app_startup" | unwrap value_total_duration_ms [$__range])
```

---

### CPU & Memory Measurements

**Memory measurement:**

```text
timestamp=2024-01-15T10:30:30.000Z kind=measurement level=info type=app_memory mem_usage=102341.56 value_mem_usage=102341.56 sdk_name=@grafana/faro-react-native app_name=react-native-sdk-demo session_id=abc-123 view_name=Home
```

**CPU measurement:**

```text
timestamp=2024-01-15T10:30:30.000Z kind=measurement level=info type=app_cpu_usage cpu_usage=23.45 value_cpu_usage=23.45 sdk_name=@grafana/faro-react-native app_name=react-native-sdk-demo session_id=abc-123 view_name=Home
```

**Query (memory):**

```logql
{app_id="YOUR_APP_ID", kind="measurement"} | logfmt | type="app_memory"
```

**Query (CPU):**

```logql
{app_id="YOUR_APP_ID", kind="measurement"} | logfmt | type="app_cpu_usage"
```

---

### Refresh Rate & Frame Monitoring

**Refresh rate:**

```text
timestamp=2024-01-15T10:30:00.000Z kind=measurement level=info type=app_refresh_rate refresh_rate=59.8 value_refresh_rate=59.8 sdk_name=@grafana/faro-react-native app_name=react-native-sdk-demo session_id=abc-123
```

**Slow frames:**

```text
timestamp=2026-02-19T09:01:08.07Z kind=measurement level=info type=app_frames_rate slow_frames=30 value_slow_frames=30 sdk_name=@grafana/faro-react-native sdk_version=2.2.3 app_name=react-native-sdk-demo view_name=CrashDemo session_id=gg4YTAcNRv
```

**Frozen frames:**

```text
timestamp=2026-02-19T08:55:07.91Z kind=measurement level=info type=app_frozen_frame frozen_frames=1 frozen_duration=10172.737 value_frozen_frames=1 value_frozen_duration=10172.737 sdk_name=@grafana/faro-react-native app_name=react-native-sdk-demo view_name=CrashDemo session_id=gg4YTAcNRv
```

**Query (refresh rate):**

```logql
{app_id="app_id", kind="measurement"} | logfmt | unwrap refresh_rate
```

**Query (slow frames):**

```logql
{app_id="app_id", kind="measurement"} | logfmt | type="app_frames_rate" | value_slow_frames=1
```

**Query (frozen frames):**

```logql
{app_id="app_id", kind="measurement"} | logfmt | type="app_frozen_frame" | value_frozen_frames=1
```

---

### Crash Reporting

iOS (PLCrashReporter) and Android (ApplicationExitInfo) emit different log data. iOS includes `context_signal`; Android includes `context_importance`.

**iOS (PLCrashReporter):**

```text
timestamp=2026-02-18T12:53:12.000Z kind=exception level=error type=crash value="SIGTRAP: Trace/BPT trap, status: 0" stacktrace="crash: SIGTRAP: Trace/BPT trap, status: 0" context_crashedSessionId=EXa9Pyv3fB context_description="Trace/BPT trap" context_pid=70948 context_processName=FaroRNDemo context_signal="SIGTRAP (#0)" context_trace="0 libswiftCore.dylib 0x000000019772c2ec\n1 FaroRNDemo.debug.dylib 0x0000000107e0c58c..." context_timestamp=1771501022000 sdk_name=@grafana/faro-react-native app_name=react-native-sdk-demo view_name=Home session_id=vbtTBw0kYK
```

**Android (ApplicationExitInfo):**

```text
timestamp=2026-02-18T13:15:00.000Z kind=exception level=error type=crash value="CRASH_NATIVE: Application crash (Native), status: 0" stacktrace="CRASH_NATIVE: Application crash (Native), status: 0" context_crashedSessionId=aB3xYz9KpL context_description="Native crash" context_importance=100 context_pid=12345 context_processName=com.example.app context_trace="*** *** *** *** *** *** ***\n  #00 pc 00012345  libc.so (abort+64)..." context_timestamp=1771502100000 sdk_name=@grafana/faro-react-native app_name=react-native-sdk-demo view_name=Home session_id=aB3xYz9KpL
```

**Query:**

```logql
{app_id="app_id", kind="exception"} | logfmt | type="crash"
```

**Query by crashed session:**

```logql
{app_id="app_id"} | logfmt | context_crashedSessionId="EXa9Pyv3fB"
```

---

### ANR Detection

ANR events are reported via crash instrumentation (ApplicationExitInfo on Android) with `type=crash` and `value` starting with "ANR:".

```text
timestamp=2026-02-26T12:42:18.166Z kind=exception level=error type=crash value="ANR: Application Not Responding, status: 0" stacktrace="crash: ANR: Application Not Responding, status: 0\n  at sendCrashReport (http://10.0.2.2:8081/index.bundle//&platform=android&dev=true&lazy=true&minify=false&app=com.farorndemo&modulesOnly=false&runModule=true&excludeSource=true&sourcePaths=url-server:104159:30)\n  at ?anon_0_ (http://10.0.2.2:8081/index.bundle//&platform=android&dev=true&lazy=true&minify=false&app=com.farorndemo&modulesOnly=false&runModule=true&excludeSource=true&sourcePaths=url-server:104132:37)..." context_crashedSessionId=hdPz7SJggU context_description="user request after error: Input dispatching timed out (4fdd0e3 com.farorndemo/com.farorndemo.MainActivity is not responding. Waited 5004ms for FocusEvent(hasFocus=true))." context_importance=100 context_mechanism=crash context_pid=17894 context_processName=com.farorndemo context_timestamp=1772109725217 context_trace="Subject: Input dispatching timed out (4fdd0e3 com.farorndemo/com.farorndemo.MainActivity is not responding. Waited 5004ms for FocusEvent(hasFocus=true)).\nRssHwmKb: 354984\nRssKb: 354816\n...\nDALVIK THREADS (56):\n\"main\" prio=5 tid=1 Sleeping\n  at java.lang.Thread.sleep(Native method)\n  at com.farorndemo.CrashTestModule.triggerANR$lambda$1(CrashTestModule.kt:63)..." sdk_name=@grafana/faro-react-native sdk_version=2.2.3 app_name=react-native-sdk-demo app_version=2.0.0 view_name=Home session_id=QN5bgr88wZ session_attr_device_os=Android
```

**Query:**

```logql
{app_id="app_id", kind="exception"} | logfmt | type="crash" | value=~"ANR.*"
```

---

### HTTP Request Instrumentation

```text
timestamp=2026-02-24T08:30:32.793Z kind=event level=info event_name=faro.tracing.fetch event_data_component=fetch event_data_duration_ns=540999936 event_data_http.host=jsonplaceholder.typicode.com event_data_http.method=GET event_data_http.scheme=https event_data_http.status_code=200 event_data_http.url=https://jsonplaceholder.typicode.com/posts/79/comments/ event_data_session.id=qmo1FHcsKL traceID=556143dfd5f5abc709b2d25cf263a751 spanID=790fcef0fdfb3d67 sdk_name=@grafana/faro-react-native app_name=react-native-sdk-demo view_name=Showcase session_id=qmo1FHcsKL
```

**Query:**

```logql
{app_id="YOUR_APP_ID", kind="event"} | logfmt | event_name="faro.tracing.fetch"
```

**Query (HTTP errors – 4xx/5xx or network failure):**

```logql
count_over_time({app_id="YOUR_APP_ID", kind="event"} |= "event_name=faro.tracing.fetch" | logfmt | (event_data_http_status_code >= 400 and event_data_http_status_code < 600) or event_data_http_status_code = 0 [$__auto])
```

---

### App State

```text
timestamp=2026-02-24T15:56:28.501Z kind=event level=info event_name=app_lifecycle_changed event_data_fromState=paused event_data_toState=resumed event_data_duration=27263 event_data_timestamp=1771948588500 sdk_name=@grafana/faro-react-native app_name=react-native-sdk-demo view_name=Home session_id=3c93ksEFuU
```

**Query:**

```logql
{app_id="YOUR_APP_ID", kind="event"} | logfmt | event_name="app_lifecycle_changed"
```

---

### Console Capture

```text
timestamp=2024-01-15T10:25:33.000Z kind=log level=info message="User opened settings" sdk_name=@grafana/faro-react-native app_name=react-native-sdk-demo session_id=abc-123 view_name=Settings
```

**Query:**

```logql
{app_id="YOUR_APP_ID", kind="log"}
```

**Query (warnings only):**

```logql
{app_id="YOUR_APP_ID", kind="log"} | logfmt | level="warn"
```

---

### Error Reporting

**Uncaught JavaScript error:**

```text
timestamp=2024-01-15T10:25:33.000Z kind=exception level=error type=Error value="This is a synchronous error for testing" context_mechanism=uncaught sdk_name=@grafana/faro-react-native app_name=react-native-sdk-demo session_id=abc-123 view_name=Profile
```

**Unhandled promise rejection:**

```text
timestamp=2024-01-15T10:25:40.000Z kind=exception level=error type=Error value="Network request failed" context_mechanism=unhandledrejection sdk_name=@grafana/faro-react-native app_name=react-native-sdk-demo session_id=abc-123
```

**Query (all exceptions, excluding crashes/ANR):**

```logql
{app_id="YOUR_APP_ID", kind="exception"} | logfmt | type!="crash"
```

**Query (uncaught errors only):**

```logql
{app_id="YOUR_APP_ID", kind="exception"} | logfmt | mechanism="uncaught"
```

---

### Session Management

**Session start:**

```text
timestamp=2026-02-26T12:42:18.096Z kind=event level=info event_name=session_start sdk_name=@grafana/faro-react-native sdk_version=2.2.3 sdk_integrations=@grafana/faro-react-native-errors:1.0.0,@grafana/faro-react-native:instrumentation-console:2.2.3,... app_name=react-native-sdk-demo app_version=2.0.0 app_environment=production user_email=emma.wilson@example.com user_id=user-005 user_username=emma_wilson user_attr_plan=enterprise user_attr_role=user session_id=QN5bgr88wZ session_attr_device_battery_level=100 session_attr_device_brand=google session_attr_device_carrier=T-Mobile session_attr_device_id=74c3c33a665223bc session_attr_device_is_charging=false session_attr_device_is_physical=false session_attr_device_manufacturer=google session_attr_device_memory_total=2067193856 session_attr_device_memory_used=230367232 session_attr_device_model=sdk_gphone64_arm64 session_attr_device_model_name=sdk_gphone64_arm64 session_attr_device_os=Android session_attr_device_os_detail="Android 16 (SDK 36)" session_attr_device_os_version=16 session_attr_device_type=mobile session_attr_faro_sdk_version=2.2.3 session_attr_react_native_version=0.82.1
```

**Session extend (event):**

```text
timestamp=2026-02-26T12:45:00.000Z kind=event level=info event_name=session_extend event_data_previousSession=8B7yPLjVLV sdk_name=@grafana/faro-react-native sdk_version=2.2.3 sdk_integrations=@grafana/faro-react-native-errors:1.0.0,@grafana/faro-react-native:instrumentation-console:2.2.3,... app_name=react-native-sdk-demo app_version=2.0.0 app_environment=production user_email=carol.white@example.com user_id=user-006 user_username=carol_white user_attr_plan=enterprise user_attr_role=user session_id=QN5bgr88wZ session_attr_previousSession=8B7yPLjVLV session_attr_device_battery_level=100 session_attr_device_brand=google session_attr_device_carrier=T-Mobile session_attr_device_id=74c3c33a665223bc session_attr_device_is_charging=false session_attr_device_is_physical=false session_attr_device_manufacturer=google session_attr_device_memory_total=2067193856 session_attr_device_memory_used=230367232 session_attr_device_model=sdk_gphone64_arm64 session_attr_device_model_name=sdk_gphone64_arm64 session_attr_device_os=Android session_attr_device_os_detail="Android 16 (SDK 36)" session_attr_device_os_version=16 session_attr_device_type=mobile session_attr_faro_sdk_version=2.2.3 session_attr_react_native_version=0.82.1
```

**Query (session starts):**

```logql
{app_id="YOUR_APP_ID", kind="event"} | logfmt | event_name="session_start"
```

**Query (session extends):**

```logql
{app_id="YOUR_APP_ID", kind="event"} | logfmt | event_name="session_extend"
```

---

### User Actions

```text
timestamp=2026-02-26T11:01:24.035Z kind=event level=info event_name=faro.user.action event_data_userActionName=manual_user_action_demo event_data_userActionDuration=119 event_data_userActionTrigger=manual event_data_source=user_actions_demo_screen action_id=Z37VNPreZN action_name=manual_user_action_demo sdk_name=@grafana/faro-react-native app_name=react-native-sdk-demo view_name=UserActionsDemo session_id=durFZnbEou view_name=UserActionsDemo
```

**Query:**

```logql
{app_id="YOUR_APP_ID"} |= "event_name=faro.user.action"
```

---

### View / Screen Tracking

```text
timestamp=2024-01-15T10:25:00.000Z kind=event level=info event_name=view_changed event_data_fromView=Home event_data_toView=Profile sdk_name=@grafana/faro-react-native app_name=react-native-sdk-demo view_name=Profile page_url=Profile session_id=abc-123
```

**Query:**

```logql
{app_id="YOUR_APP_ID", kind="event"} | logfmt | event_name="view_changed"
```

---
