import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Every Park",
  description: "A small full-stack application",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
