import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Grabber · Stacklis",
  description: "Local multi-tool downloader — yt-dlp + gallery-dl with live progress.",
  openGraph: {
    title: "Grabber · Stacklis",
    description: "Local multi-tool downloader.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#00d9ff",
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.png" />
      </head>
      <body>{children}</body>
    </html>
  );
}
