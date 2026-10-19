import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import AppearanceInitializer from '@/components/appearance-initializer';
import '@fontsource/montserrat/100.css';
import '@fontsource/montserrat/700.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'A.A.C. — Assistente de Administração Comercial',
  description: 'Gestão comercial simples, clara e organizada.',
  manifest: '/manifest.json',
  icons: { icon: '/icon.svg' }
};

export const viewport: Viewport = {
  themeColor: '#f5f6f7'
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>
        <AppearanceInitializer />
        {children}
      </body>
    </html>
  );
}
