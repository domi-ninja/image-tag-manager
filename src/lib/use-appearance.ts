import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow, type Theme } from '@tauri-apps/api/window';
import { useEffect, useLayoutEffect, useState } from 'react';

export type Appearance = 'system' | Theme;

const STORAGE_KEY = 'image-tag-manager.appearance';
const BACKGROUNDS: Record<Theme, string> = { light: '#f7f7f2', dark: '#30343b' };

function savedAppearance(): Appearance {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

function webSystemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(savedAppearance);
  const [systemTheme, setSystemTheme] = useState<Theme>(webSystemTheme);

  useLayoutEffect(
    function applyAppearance() {
      const theme = appearance === 'system' ? systemTheme : appearance;
      document.documentElement.dataset.theme = theme;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', BACKGROUNDS[theme]);
    },
    [appearance, systemTheme],
  );

  useEffect(
    function followDesktopTheme() {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const onMediaChange = () => setSystemTheme(media.matches ? 'dark' : 'light');
      media.addEventListener('change', onMediaChange);
      if (appearance === 'system') onMediaChange();

      if (!isTauri()) return () => media.removeEventListener('change', onMediaChange);

      const appWindow = getCurrentWindow();
      let disposed = false;
      let unlisten: (() => void) | undefined;
      void appWindow
        .onThemeChanged(({ payload }) => {
          if (!disposed && appearance === 'system') setSystemTheme(payload);
        })
        .then((stopListening) => {
          if (disposed) void stopListening();
          else unlisten = stopListening;
        })
        .catch((error: unknown) => console.warn('Could not watch the desktop theme', error));
      void appWindow
        .setTheme(appearance === 'system' ? null : appearance)
        .then(() => (appearance === 'system' ? appWindow.theme() : null))
        .then((theme) => {
          if (!disposed && theme) setSystemTheme(theme);
        })
        .catch((error: unknown) => console.warn('Could not set the window theme', error));

      return () => {
        disposed = true;
        media.removeEventListener('change', onMediaChange);
        if (unlisten) void unlisten();
      };
    },
    [appearance],
  );

  function changeAppearance(next: Appearance) {
    setAppearance(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The setting still works for this session when storage is unavailable.
    }
  }

  return { appearance, changeAppearance };
}
