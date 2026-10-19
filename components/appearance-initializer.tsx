'use client';

import { useEffect } from 'react';
import { applySavedAccentColor, applySavedTheme } from '@/lib/appearance';

export default function AppearanceInitializer() {
  useEffect(() => {
    applySavedAccentColor();
    applySavedTheme();
  }, []);

  return null;
}
