import type { Metadata } from "next";
import { Unbounded, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

// Display face — approved pairing swap (Archivo → Unbounded): a wide,
// geometric-bold face for the BNI ad campaign headlines. Only the weights
// actually used are loaded — 700 and 900, matching every font-display call
// site's font-bold/font-black usage (font-extrabold/800 was retired
// alongside this swap since it isn't one of the two loaded weights) —
// keeping the self-hosted payload small: next/font fetches and subsets
// these at BUILD time and serves them from this app's own origin, so the
// kiosk never makes a runtime request to Google Fonts (important — it has
// to keep working on uncertain venue wifi).
//
// IMPORTANT: Unbounded is noticeably WIDER than Archivo was. Every
// font-display call site got its own sizing pass alongside this swap rather
// than assuming the old sizes still fit — see e.g. KioskRail's clock and
// SplashView's heading in app/kiosk/kiosk-client.tsx for the call-site-level
// reasoning.
const unbounded = Unbounded({
  variable: "--font-unbounded",
  subsets: ["latin"],
  weight: ["700", "900"],
});

// UI face — approved pairing swap (Instrument Sans → Plus Jakarta Sans), the
// default sans for everything that isn't a headline. Wired into Tailwind's
// theme as --font-sans (see app/globals.css's @theme inline block), so the
// existing font-sans utility and the body's default both pick it up without
// touching every call site.
const plusJakartaSans = Plus_Jakarta_Sans({
  variable: "--font-plus-jakarta-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
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
      className={`${unbounded.variable} ${plusJakartaSans.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
