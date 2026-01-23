import type { NavigationState, PartialState } from '@react-navigation/native';

/**
 * React Navigation dependencies that need to be provided by the user
 */
export interface ReactNavigationDependencies {
  useNavigation: () => { navigate: (name: string, params?: object) => void };
  useRoute: () => { key: string; name: string; params?: object };
  useNavigationState: <T>(selector: (state: NavigationState | PartialState<NavigationState>) => T) => T;
}

/**
 * Configuration for React Navigation integration
 */
export interface ReactNavigationConfig {
  dependencies: ReactNavigationDependencies;
}
