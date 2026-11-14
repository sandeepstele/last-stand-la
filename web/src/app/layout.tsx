import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Retrofit Radar",
  description: "Ground-truths commercial buildings across CoStar, Vexcel and Matterport, then sizes the retrofit.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
