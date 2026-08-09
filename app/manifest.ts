import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'BNI Wheeling',
    short_name: 'BNI Wheeling',
    description: 'Weekly meeting check-in for BNI Wheeling',
    start_url: '/kiosk',
    display: 'standalone',
    background_color: '#f7f7f9',
    theme_color: '#CF2030',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
