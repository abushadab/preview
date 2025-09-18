import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sandbox App',
  description: 'A Next.js app running in sandbox environment',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}