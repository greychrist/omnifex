import React, { createContext, useState, useContext, useCallback, useEffect } from 'react';
import { api } from '../lib/api';
import { logAndForget } from "@/lib/fireAndLog";

export type ThemeMode = 'gray' | 'light';

interface ThemeContextType {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => Promise<void>;
  isLoading: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const THEME_STORAGE_KEY = 'theme_preference';

// Stored values from older builds ('dark', 'custom', 'white') map to a supported mode.
function normalizeTheme(raw: string | null): ThemeMode {
  if (raw === 'light') return 'light';
  return 'gray';
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemeMode>('gray');
  const [isLoading, setIsLoading] = useState(true);

  const applyTheme = useCallback(async (themeMode: ThemeMode) => {
    const root = document.documentElement;

    // Includes legacy classes an older build may have set.
    root.classList.remove('theme-dark', 'theme-gray', 'theme-light', 'theme-custom', 'theme-white');

    root.classList.add(`theme-${themeMode}`);

    // A legacy custom theme may have set inline --color-* variables.
    const legacyColorVars = [
      '--color-background', '--color-foreground', '--color-card', '--color-card-foreground',
      '--color-primary', '--color-primary-foreground', '--color-secondary',
      '--color-secondary-foreground', '--color-muted', '--color-muted-foreground',
      '--color-accent', '--color-accent-foreground', '--color-destructive',
      '--color-destructive-foreground', '--color-border', '--color-input', '--color-ring',
    ];
    for (const v of legacyColorVars) root.style.removeProperty(v);
  }, []);

  useEffect(() => {
    const loadTheme = async () => {
      try {
        const savedTheme = await api.getSetting(THEME_STORAGE_KEY);
        const themeMode = normalizeTheme(savedTheme);
        setThemeState(themeMode);
        await applyTheme(themeMode);
      } catch (error) {
        console.error('Failed to load theme settings:', error);
      } finally {
        setIsLoading(false);
      }
    };

    logAndForget('theme-context:load-theme', loadTheme());
  }, [applyTheme]);

  const setTheme = useCallback(async (newTheme: ThemeMode) => {
    try {
      setIsLoading(true);
      setThemeState(newTheme);
      await applyTheme(newTheme);
      await api.saveSetting(THEME_STORAGE_KEY, newTheme);
    } finally {
      setIsLoading(false);
    }
  }, [applyTheme]);

  const value: ThemeContextType = {
    theme,
    setTheme,
    isLoading,
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useThemeContext = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useThemeContext must be used within a ThemeProvider');
  }
  return context;
};
