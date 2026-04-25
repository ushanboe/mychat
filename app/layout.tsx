import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
    title: "Secure Chat",
    description: "End-to-end encrypted chat for two",
};

export const viewport: Viewport = {
    width: "device-width",
    initialScale: 1,
    maximumScale: 1,
    userScalable: false,
    viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
