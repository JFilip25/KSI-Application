import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Apply to KSI Montenegro",
  description: "A focused application for Knightsbridge Schools International Montenegro.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
