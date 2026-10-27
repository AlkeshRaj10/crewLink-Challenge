import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CrewLink | Leadership",
  description: "Create, review, and send local member callouts.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
