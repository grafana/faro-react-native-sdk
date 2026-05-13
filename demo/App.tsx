/**
 * Faro React Native Demo App
 * Demonstrates the Grafana Faro React Native SDK
 */

import React, { useEffect } from 'react';
import { StatusBar, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { initFaro } from './src/faro/initialize';
import { AppNavigator } from './src/navigation/AppNavigator';
import { getRandomUser } from './src/utils/randomUser';

function App() {
  const isDarkMode = useColorScheme() === 'dark';

  useEffect(() => {
    async function initialize() {
      try {
        const faro = await initFaro();

        // Set a random user on app mount
        if (faro?.api) {
          const randomUser = getRandomUser();
          faro.api.setUser({
            id: randomUser.id,
            email: randomUser.email,
            username: randomUser.username,
            attributes: randomUser.attributes,
          });
        }
      } catch (error) {
        console.error('Failed to initialize Faro:', error);
      }
    }

    void initialize();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <AppNavigator />
    </SafeAreaProvider>
  );
}

export default App;
