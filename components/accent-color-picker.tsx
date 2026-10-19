'use client';

import { useEffect, useState } from 'react';
import { applyAccentColor, DEFAULT_ACCENT_COLOR, getDefaultAccentColor } from '@/lib/appearance';

export default function AccentColorPicker() {
  const [color, setColor] = useState(DEFAULT_ACCENT_COLOR);

  useEffect(() => {
    const savedColor = window.localStorage.getItem('aac-accent-color');
    if (savedColor && /^#[\da-f]{6}$/i.test(savedColor)) {
      setColor(savedColor);
      applyAccentColor(savedColor);
      return;
    }
    setColor(getDefaultAccentColor());
  }, []);

  useEffect(() => {
    function syncDefaultColor() {
      if (!window.localStorage.getItem('aac-accent-color')) setColor(getDefaultAccentColor());
    }
    window.addEventListener('aac-theme-change', syncDefaultColor);
    return () => window.removeEventListener('aac-theme-change', syncDefaultColor);
  }, []);

  function changeColor(value: string) {
    setColor(value);
    applyAccentColor(value);
    window.localStorage.setItem('aac-accent-color', value);
  }

  return (
    <div className="accent-picker">
      <label htmlFor="aacAccentColor">Cor de destaque</label>
      <div className="accent-picker-control">
        <input
          id="aacAccentColor"
          type="color"
          value={color}
          onChange={event => changeColor(event.target.value)}
          aria-describedby="accentColorDescription"
        />
        <output htmlFor="aacAccentColor">{color.toUpperCase()}</output>
      </div>
      <p id="accentColorDescription">A cor escolhida será aplicada aos destaques e botões e ficará salva neste navegador.</p>
    </div>
  );
}
