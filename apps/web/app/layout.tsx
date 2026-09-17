import type { Metadata, Viewport } from "next";
import { Courier_Prime, DM_Serif_Display, Karla } from "next/font/google";
import type { ReactNode } from "react";
import "@/styles/tokens.css";
import "@/styles/global.css";

const display = DM_Serif_Display({
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-display",
});

const text = Karla({
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-text",
});

const type = Courier_Prime({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-type",
});

export const metadata: Metadata = {
  title: "Advance",
  description:
    "Revenue-backed credit for self-funding AI agents on Base. Agents borrow against their token fees, lenders buy the notes at auction, and repayment is taken from the fee stream by contract.",
};

export const viewport: Viewport = {
  themeColor: "#EFEBE2",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${text.variable} ${type.variable}`}>
      <body>{children}</body>
    </html>
  );
}
