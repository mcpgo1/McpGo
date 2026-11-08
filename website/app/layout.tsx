import type { Metadata, Viewport } from "next";
import "./globals.css";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "McpGo — кодинг как с Codex без отдельного API-счёта",
    template: "%s · McpGo",
  },
  description:
    "McpGo подключает инструменты Mac к ChatGPT для работы с кодом без отдельного счёта за токены Codex API. Официальный MCP, без обхода лимитов ChatGPT.",
  applicationName: "McpGo",
  keywords: ["McpGo", "MCP", "ChatGPT", "macOS", "Playwright", "Terminal", "Secure MCP Tunnel", "open source"],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "ru_RU",
    siteName: "McpGo",
    title: "McpGo — кодинг как с Codex без отдельного API-счёта",
    description: "Код, сборки и тесты в ChatGPT через официальный MCP. Без отдельной оплаты Codex API, с обычными лимитами ChatGPT.",
    url: "/",
  },
  icons: { icon: "/mcpgo-mark.svg", apple: "/mcpgo-mark.svg" },
  twitter: {
    card: "summary_large_image",
    title: "McpGo — ваш Mac. Ваш AI.",
    description: "Бесплатный open-source инструмент для macOS и MCP.",
  },
};

export const viewport: Viewport = {
  themeColor: "#080b10",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
