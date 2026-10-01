import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import "./globals.css";

// PRD 12.2, Noboru brand theme: Poppins. shadcn/ui reads the body font from
// --font-sans (see app/globals.css).
const poppins = Poppins({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Knit",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${poppins.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
