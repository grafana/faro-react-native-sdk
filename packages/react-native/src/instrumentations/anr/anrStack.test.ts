import { isInvalidAnrCaptureStack } from './anrStack';

describe('isInvalidAnrCaptureStack', () => {
  it('rejects empty stacks', () => {
    expect(isInvalidAnrCaptureStack(undefined)).toBe(true);
    expect(isInvalidAnrCaptureStack('')).toBe(true);
  });

  it('rejects crash-handler contamination', () => {
    const stack = `
    at com.android.internal.os.RuntimeInit$KillApplicationHandler.uncaughtException(RuntimeInit.java:174)
    at com.grafana.faro.reactnative.FaroUncaughtExceptionHandler.uncaughtException(FaroUncaughtExceptionHandler.kt:42)
    `.trim();

    expect(isInvalidAnrCaptureStack(stack)).toBe(true);
  });

  it('accepts a typical blocked main-thread stack', () => {
    const stack = `
    at com.example.myapp.ui.HomeFragment.loadCatalog(HomeFragment.kt:84)
    at com.example.myapp.ui.HomeFragment.onResume(HomeFragment.kt:52)
    at android.app.Activity.performResume(Activity.java:8911)
    `.trim();

    expect(isInvalidAnrCaptureStack(stack)).toBe(false);
  });
});
