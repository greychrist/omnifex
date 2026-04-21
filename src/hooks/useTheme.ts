import { useThemeContext } from '../contexts/ThemeContext';

/**
 * Hook to access and control the theme system
 *
 * @returns {Object} Theme utilities and state
 * @returns {ThemeMode} theme - Current theme mode ('gray' | 'light')
 * @returns {Function} setTheme - Function to change the theme mode
 * @returns {boolean} isLoading - Whether theme operations are in progress
 *
 * @example
 * const { theme, setTheme } = useTheme();
 * await setTheme('light');
 */
export const useTheme = () => {
  return useThemeContext();
};