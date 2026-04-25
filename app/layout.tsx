import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
    title: "Secure Chat",
    description: "End-to-end encrypted chat for two",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
