import type { Metadata } from "next";
import { Provider } from "@/components/provider";
import { Shell } from "@/components/shell";
import "./globals.css";

export const metadata: Metadata = { title: { default: "Kivro | Capability marketplace", template: "%s | Kivro" }, description: "Find specialized capabilities, run jobs, and manage your marketplace work." };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" data-scroll-behavior="smooth"><body><Provider><Shell>{children}</Shell></Provider></body></html>;
}
