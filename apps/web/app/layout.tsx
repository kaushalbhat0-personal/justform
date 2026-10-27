import type * as React from "react";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FORMOS",
  description: "Team form platform — workspaces, RBAC, and submission collaboration.",
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="muted" style={{ position: "absolute", left: -9999 }}>
          Skip to content
        </a>
        <main id="main" className="shell">{children}</main>
      </body>
    </html>
  );
}
