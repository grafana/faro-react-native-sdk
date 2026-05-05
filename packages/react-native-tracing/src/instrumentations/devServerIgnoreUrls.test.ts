import { getReactNativeDevServerIgnoreUrls } from './devServerIgnoreUrls';

describe('getReactNativeDevServerIgnoreUrls', () => {
  const ignoredUrlPattern = getReactNativeDevServerIgnoreUrls()[0] as RegExp;

  it.each([
    'http://localhost:8081/symbolicate',
    'http://localhost:8081/symbolicate?platform=ios',
    'http://127.0.0.1:8081/symbolicate',
    'http://[::1]:8081/symbolicate',
    'http://10.0.2.2:8081/symbolicate',
  ])('matches React Native dev-server symbolication URL %s', (url) => {
    expect(ignoredUrlPattern.test(url)).toBe(true);
  });

  it.each([
    'https://api.example.com/symbolicate',
    'https://api.example.com/v1/symbolicate',
    'https://api.example.com/symbolicate-events',
  ])('does not match backend symbolication-like URL %s', (url) => {
    expect(ignoredUrlPattern.test(url)).toBe(false);
  });
});
