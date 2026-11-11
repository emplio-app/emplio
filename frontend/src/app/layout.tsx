import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, DM_Sans, Fredoka, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { THEME_SCRIPT } from "@/lib/theme";
import { ogImage, SiteHead, siteMetadata } from "@cloud/site";

const sans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"], axes: ["opsz"] });
const heading = Bricolage_Grotesque({ variable: "--font-bricolage", subsets: ["latin"], axes: ["opsz"] });
const mono = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });
const logo = Fredoka({ variable: "--font-logo", subsets: ["latin"], weight: "500" });

const DESCRIPTION =
  "Emplio is an AI employee for small businesses. It has its own computer and browser, works with your team from their phones, follows up, prepares reports overnight and checks with you before anything big.";

export const metadata: Metadata = {
  title: { default: "Emplio: an AI employee who never clocks out", template: "%s · Emplio" },
  description: DESCRIPTION,
  applicationName: "Emplio",
  // added to an iPhone's home screen, it opens as its own app (Android: manifest.ts)
  appleWebApp: { capable: true, title: "Emplio", statusBarStyle: "default" },
  keywords: [
    "AI employee",
    "AI employee for small business",
    "AI assistant for business",
    "AI agent for business",
    "AI employee on your phone",
    "business automation",
    "AI back office",
    "virtual assistant for small business",
    "Emplio",
  ],
  openGraph: {
    type: "website",
    siteName: "Emplio",
    title: "Emplio: an AI employee who never clocks out",
    description: "Its own computer, works with your team from their phones, checks with you before anything big.",
    locale: "en_IN",
    // a plain file: the opengraph-image convention would hang an image off every route, including /chat's catch-all
    images: [{ url: ogImage, width: 1200, height: 630, alt: "Emplio: an AI employee who never clocks out" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Emplio: an AI employee who never clocks out",
    description: "Its own computer, works with your team from their phones, checks with you before anything big.",
    images: [ogImage],
  },
  // a self-hosted install stays out of search engines; Emplio Cloud's own site (siteMetadata) is meant to be found
  ...siteMetadata,
};

// edge to edge on notched phones (safe-area padding where it matters); Android shrinks the page
// for the keyboard instead of covering it
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfaf8" },
    { media: "(prefers-color-scheme: dark)", color: "#1c1b19" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${heading.variable} ${mono.variable} ${logo.variable} h-full antialiased`}
      // the theme script sets .dark before React loads
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <SiteHead />
      </head>
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
