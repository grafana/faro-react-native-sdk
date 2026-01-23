# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

## Package Overview

`@grafana/faro-react-native-tracing` provides OpenTelemetry distributed tracing integration for the Faro React Native SDK.

**Key Features:**

- Automatic HTTP request tracing via `fetch()` instrumentation
- Manual span creation using OpenTelemetry API
- W3C Trace Context propagation for distributed tracing
- Correlation with Faro sessions, users, and device metadata
- Batch span export to Faro collector

## Commands

```bash
# Run tests
yarn quality:test

# Run tests in watch mode
yarn quality:test --watch

# Build
yarn build

# Watch mode
yarn watch

# Lint
yarn quality:lint

# Format
yarn quality:format
```

## Architecture

### Trace Flow

```
fetch() call
    ↓
FetchInstrumentation (OTEL) - Creates span, adds trace headers
    ↓
FaroMetaAttributesSpanProcessor - Enriches with Faro metadata
    ↓
BatchSpanProcessor (OTEL) - Batches spans (30 max, 1s delay)
    ↓
FaroTraceExporter - Converts to OTLP format
    ↓
faro.api.pushTraces() - Sends to Faro collector
```

### Key Components

**TracingInstrumentation (`src/instrumentation.ts`):**

- Main instrumentation class
- Registers OpenTelemetry provider
- Sets up fetch instrumentation
- Configures span processors and exporters
- Exposes OTEL APIs via `faro.otel`

**FaroTraceExporter (`src/exporters/faroTraceExporter.ts`):**

- Implements OpenTelemetry `SpanExporter` interface
- Converts ReadableSpan to OTLP format
- Calls `faro.api.pushTraces()` to send spans
- Handles export failures gracefully

**FaroMetaAttributesSpanProcessor (`src/processors/faroMetaAttributesSpanProcessor.ts`):**

- Wraps another SpanProcessor
- Adds Faro metadata to spans on start:
  - Session ID and attributes
  - User ID, username, email
  - Device model, brand, OS, locale
  - User action correlation (if active)

**getDefaultOTELInstrumentations (`src/instrumentations/getDefaultOTELInstrumentations.ts`):**

- Returns default OpenTelemetry instrumentations
- Currently only FetchInstrumentation
- Automatically filters collector URLs from tracing

## Infinite Loop Prevention

**Critical:** Tracing must NOT trace itself. Multiple safeguards:

1. **Automatic URL filtering:**
   - Collector URLs extracted from transport config
   - Both with/without trailing slashes
   - Added to FetchInstrumentation ignore list

2. **Internal logging:**
   - Uses `internalLogger.error()` instead of `console.error()`
   - Internal logger doesn't trigger ConsoleInstrumentation

3. **No console in exporters:**
   - FaroTraceExporter never uses console.log
   - Errors logged via internalLogger

4. **Batch processing:**
   - BatchSpanProcessor delays export
   - Prevents immediate re-tracing of export requests

## Manual Span Creation

Users can create custom spans via `faro.otel`:

```typescript
const { trace, context } = faro.otel;
const tracer = trace.getTracer('my-app');

// Simple span
const span = tracer.startSpan('operation-name');
span.setAttribute('key', 'value');
span.end();

// Nested spans
const parentSpan = tracer.startSpan('parent');
await context.with(trace.setSpan(context.active(), parentSpan), async () => {
  const childSpan = tracer.startSpan('child');
  // Child is automatically linked to parent
  childSpan.end();
});
parentSpan.end();
```

## Context Propagation

**W3C Trace Context Headers:**

- `traceparent`: Contains trace ID, span ID, flags
- `tracestate`: Vendor-specific data

Headers are added to fetch requests if URL matches `propagateTraceHeaderCorsUrls` patterns.

**Configuration:**

```typescript
new TracingInstrumentation({
  instrumentationOptions: {
    propagateTraceHeaderCorsUrls: [/https:\/\/api\.example\.com/, 'https://other-api.com'],
  },
});
```

## Span Attributes

Every span includes:

**Standard OTEL:**

- `http.method`, `http.url`, `http.status_code`
- `http.target`, `http.host`

**Faro Metadata:**

- `session.id` - Faro session ID
- `enduser.id`, `enduser.username`, `enduser.email` - User info
- `device.model`, `device.brand`, `device.platform` - Device info
- `service.name`, `service.version` - App info

**User Action Correlation:**

- `faro.action.user.name` - Active user action name
- `faro.action.user.parentId` - Parent action ID

## Testing Patterns

### Testing FaroTraceExporter

```typescript
import { FaroTraceExporter } from '../faroTraceExporter';

it('should export spans', (done) => {
  const mockApi = {
    pushTraces: jest.fn(),
  };
  const exporter = new FaroTraceExporter({ api: mockApi });

  exporter.export([mockSpan], (result) => {
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(mockApi.pushTraces).toHaveBeenCalled();
    done();
  });
});
```

### Testing FaroMetaAttributesSpanProcessor

```typescript
it('should add session attributes', () => {
  const metas = { value: { session: { id: '123' } } };
  const mockSpan = {
    attributes: {},
    setAttribute: jest.fn(),
  };

  processor.onStart(mockSpan);

  expect(mockSpan.setAttribute).toHaveBeenCalledWith('session.id', '123');
});
```

### Testing TracingInstrumentation

Mock the OpenTelemetry provider:

```typescript
jest.mock('@opentelemetry/sdk-trace-base', () => ({
  BasicTracerProvider: jest.fn().mockImplementation(() => ({
    register: jest.fn(),
    addSpanProcessor: jest.fn(),
  })),
}));
```

## Distributed Tracing Setup

### Frontend (React Native)

```typescript
import { TracingInstrumentation } from '@grafana/faro-react-native-tracing';

initializeFaro({
  instrumentations: [
    new TracingInstrumentation({
      instrumentationOptions: {
        propagateTraceHeaderCorsUrls: [/https:\/\/api\.example\.com/],
      },
    }),
  ],
});
```

### Backend (Node.js + Express)

```javascript
const { W3CTraceContextPropagator } = require('@opentelemetry/core');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');

const provider = new NodeTracerProvider();
provider.register({
  propagator: new W3CTraceContextPropagator(),
});

// Enable CORS for trace headers
app.use(
  cors({
    allowedHeaders: ['traceparent', 'tracestate'],
  })
);
```

## Common Issues

### "OTEL is not available" error

Cause: Trying to use `faro.otel` before TracingInstrumentation is initialized.

Solution: Add TracingInstrumentation to config:

```typescript
initializeFaro({
  instrumentations: [new TracingInstrumentation()],
});
```

### Infinite loop / exponential requests

Cause: Trace export requests are being traced, creating a loop.

Solution: This should be automatically prevented. Check:

1. Collector URLs are filtered in FetchInstrumentation
2. No console.log in span processors or exporters
3. Using internalLogger for errors

Debug:

```typescript
const transport = faro.config.transports[0];
console.log('Ignored URLs:', transport.getIgnoreUrls());
```

### Spans missing user/session context

Cause: FaroMetaAttributesSpanProcessor not wrapping span processor.

Solution: Use default span processor or wrap custom processor:

```typescript
new TracingInstrumentation({
  spanProcessor: new FaroMetaAttributesSpanProcessor(customProcessor, faro.metas),
});
```

### Backend spans not in frontend trace

Causes:

1. Backend not configured for W3C Trace Context
2. CORS blocking trace headers
3. Backend URL not in `propagateTraceHeaderCorsUrls`

Solutions:

1. Configure W3C propagator on backend
2. Add `traceparent` and `tracestate` to CORS allowed headers
3. Add backend URL to propagation list

## Performance Considerations

**Overhead:**

- ~5-10ms per HTTP request (automatic tracing)
- ~0.5-1ms per manual span
- Batch processing minimizes network impact

**Optimization:**

1. **Sample sessions** - Don't trace every session:

```typescript
sessionTracking: {
  samplingRate: 0.1, // 10% of sessions
}
```

2. **Increase batch size** - Reduce network requests:

```typescript
new BatchSpanProcessor(exporter, {
  maxExportBatchSize: 50,
  scheduledDelayMillis: 2000,
});
```

3. **Filter spans** - Don't trace internal requests:

```typescript
fetchInstrumentationOptions: {
  applyCustomAttributesOnSpan: (span, request) => {
    if (request.url.includes('/health')) {
      span.setAttribute('skip', true);
    }
  },
}
```

## Code Maintenance

### Adding New Span Attributes

Edit `FaroMetaAttributesSpanProcessor.onStart()`:

```typescript
onStart(span: Span): void {
  const metas = this.metas.value;

  // Add new attribute
  if (metas.myNewMeta) {
    span.setAttribute('my.new.attribute', metas.myNewMeta.value);
  }
}
```

### Adding New OTEL Instrumentations

Edit `getDefaultOTELInstrumentations()`:

```typescript
export function getDefaultOTELInstrumentations(options) {
  return [
    new FetchInstrumentation(options),
    new XMLHttpRequestInstrumentation(), // New
  ];
}
```

### Updating OpenTelemetry Dependencies

OpenTelemetry packages should stay in sync:

- `@opentelemetry/api`
- `@opentelemetry/sdk-trace-base`
- `@opentelemetry/instrumentation-fetch`
- `@opentelemetry/core`
- `@opentelemetry/resources`
- `@opentelemetry/semantic-conventions`

Check compatibility before updating.

## Debugging

### Enable Trace Logging

OpenTelemetry has built-in diagnostics:

```typescript
import { DiagConsoleLogger, DiagLogLevel, diag } from '@opentelemetry/api';

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
```

### Inspect Spans Before Export

Add logging to FaroTraceExporter:

```typescript
export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
  console.log('Exporting spans:', spans.length);
  spans.forEach(span => {
    console.log('Span:', span.name, span.attributes);
  });
  // ... existing code
}
```

### Verify Trace Context Propagation

Check request headers in fetch instrumentation:

```typescript
fetchInstrumentationOptions: {
  applyCustomAttributesOnSpan: (span, request) => {
    console.log('Request headers:', request.headers);
  },
}
```
