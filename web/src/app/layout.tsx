import type { Metadata } from "next";
import { IBM_Plex_Sans_Condensed } from "next/font/google";
import "./globals.css";

// The game's one UI typeface, self-hosted at build time (works offline). Exposed as --font-ui; the auditor keeps its own font.
const plex = IBM_Plex_Sans_Condensed({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-ui",
});

export const metadata: Metadata = {
  title: "Last Stand LA",
  description: "Ground-truths commercial buildings across CoStar, Vexcel and Matterport, then sizes the retrofit.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={plex.variable}>
      <body>{children}</body>
    </html>
  );
}
