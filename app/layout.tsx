import type { Metadata } from "next";
import { Archivo, Instrument_Sans } from "next/font/google";
import "./globals.css";

// Display face — the condensed-bold DNA of the BNI ad campaign (see
// public/ads/*.png). Only the weights actually used are loaded (every
// font-display heading goes straight to bold/extrabold), keeping the
// self-hosted payload small: next/font fetches and subsets these at BUILD
// time and serves them from this app's own origin, so the kiosk never makes
// a runtime request to Google Fonts (important — it has to keep working on
// uncertain venue wifi).
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  weight: ["700", "800", "900"],
});

// UI face — the default sans for everything that isn't a headline. Wired
// into Tailwind's theme as --font-sans (see app/globals.css's @theme inline
// block), so the existing font-sans utility and the body's default both
// pick it up without touching every call site.
const instrumentSans = Instrument_Sans({
  variable: "--font-instrument-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "BNI Wheeling check-in",
  description: "Weekly meeting check-in for BNI Wheeling",
  icons: { apple: "/icon-192.png" },
  appleWebApp: { capable: true, title: "BNI Wheeling", statusBarStyle: "default" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${instrumentSans.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
