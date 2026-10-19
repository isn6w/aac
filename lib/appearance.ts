export const DEFAULT_ACCENT_COLOR = '#ffffff';

export function getDefaultAccentColor() {
  return document.documentElement.dataset.theme === 'light' ? '#000000' : DEFAULT_ACCENT_COLOR;
}

function getAccentForeground(color: string) {
  const channels = color.slice(1).match(/.{2}/g)?.map(value => Number.parseInt(value, 16) / 255);
  if (!channels || channels.length !== 3) return '#ffffff';
  const [red, green, blue] = channels.map(channel =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const whiteContrast = 1.05 / (luminance + 0.05);
  const darkContrast = (luminance + 0.05) / 0.05;
  return whiteContrast >= darkContrast ? '#ffffff' : '#101827';
}

export function applyAccentColor(color: string) {
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-strong', `color-mix(in srgb, ${color} 76%, black)`);
  document.documentElement.style.setProperty('--accent-foreground', getAccentForeground(color));
  document.documentElement.style.setProperty('--focus', color);
  document.documentElement.style.setProperty('--accent-soft', `color-mix(in srgb, ${color} 14%, transparent)`);
  document.documentElement.style.setProperty('--accent-shadow', `color-mix(in srgb, ${color} 28%, transparent)`);
  document.documentElement.dataset.accent = color;
}

export function applySavedAccentColor() {
  const savedColor = window.localStorage.getItem('aac-accent-color');
  if (savedColor === '#4595ff') window.localStorage.removeItem('aac-accent-color');
  else if (savedColor && /^#[\da-f]{6}$/i.test(savedColor)) applyAccentColor(savedColor);
}

export function applySavedTheme() {
  const savedTheme = window.localStorage.getItem('aac-theme');
  const theme = savedTheme === 'light' || savedTheme === 'dark'
    ? savedTheme
    : window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  return theme;
}
