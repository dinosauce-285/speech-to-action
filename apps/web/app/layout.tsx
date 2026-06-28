import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Voice → JSON · Test Client',
  description: 'Test client cho API điều khiển robot bằng giọng nói',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">{children}</body>
    </html>
  );
}
