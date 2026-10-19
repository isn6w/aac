'use client';

import { useEffect, useState } from 'react';
import { applySavedTheme } from '@/lib/appearance';

type Theme = 'dark' | 'light';

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    const initialTheme = applySavedTheme();
    setTheme(initialTheme);
  }, []);

  function toggleTheme() {
    const nextTheme: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
    window.localStorage.setItem('aac-theme', nextTheme);
    window.dispatchEvent(new Event('aac-theme-change'));
  }

  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={toggleTheme}
      aria-label={`Ativar modo ${theme === 'dark' ? 'claro' : 'escuro'}`}
      title={`Ativar modo ${theme === 'dark' ? 'claro' : 'escuro'}`}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☼' : '◐'}</span>
      <span className="theme-toggle-label">{theme === 'dark' ? 'Escuro' : 'Claro'}</span>
    </button>
  );
}
