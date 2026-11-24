import { useThemeContext } from '../contexts/ThemeContext';

export const useTheme = () => {
  return useThemeContext();
};