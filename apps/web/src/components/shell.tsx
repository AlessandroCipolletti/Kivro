"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Blocks, BriefcaseBusiness, ChartNoAxesColumn, ChevronRight, Compass, Heart, LayoutDashboard, LogOut, Menu, MessageSquareText, Monitor, Settings, ShieldCheck, Wallet, X } from "lucide-react";
import { useApp } from "./provider";
import { IconButton, Button } from "./ui";
import { useResource } from "@/lib/hooks";
import type { Wallet as WalletDTO } from "@/lib/types";
import { money } from "@/lib/format";

const primary = [{ href: "/", name: "Discover", icon: Compass }, { href: "/agent", name: "AI Request", icon: MessageSquareText }, { href: "/jobs", name: "My jobs", icon: BriefcaseBusiness }, { href: "/favorites", name: "Favorites", icon: Heart }];
const selling = [{ href: "/selling", name: "Overview", icon: LayoutDashboard }, { href: "/selling/capabilities", name: "Capabilities", icon: Blocks }, { href: "/selling/workers", name: "Worker health", icon: Monitor }, { href: "/selling/earnings", name: "Earnings", icon: ChartNoAxesColumn }];
export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, authenticate, logout, config } = useApp();
  const wallet = useResource<WalletDTO>(user ? "/wallet" : null, 30000);
  const [mobile, setMobile] = useState(false);
  const [compact, setCompact] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 720px)");
    const update = () => { setCompact(media.matches); if (!media.matches) setMobile(false); };
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!mobile) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(sidebar.current?.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)") || []).filter(node => node.getClientRects().length);
    focusables()[0]?.focus();
    function keyboard(event: KeyboardEvent) {
      if (event.key === "Escape") setMobile(false);
      if (event.key !== "Tab") return;
      const items = focusables(), first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", keyboard);
    const overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", keyboard); document.body.style.overflow = overflow; previous?.focus(); };
  }, [mobile]);
  useEffect(() => setMobile(false), [pathname]);
  const all = [...primary, ...selling, { href: "/wallet", name: "Wallet" }, { href: "/settings", name: "Settings" }, { href: "/admin", name: "Administration" }];
  const current = all.filter(item => item.href !== "/" && pathname.startsWith(item.href)).sort((a,b) => b.href.length - a.href.length)[0]?.name || "Discover";
  const nav = (items: typeof primary) => items.map(({ href, name, icon: Icon }) => <Link key={href} href={href} className={`nav-link ${pathname === href || href !== "/" && href !== "/selling" && pathname.startsWith(`${href}/`) ? "active" : ""}`} aria-current={pathname === href ? "page" : undefined}><Icon size={18} /><span>{name}</span>{pathname === href && <span className="nav-indicator" />}</Link>);
  return <div className="app-shell">
    <a className="skip-link" href="#main">Skip to content</a>
    {mobile && <button className="sidebar-overlay" aria-label="Close navigation" onClick={() => setMobile(false)} />}
    <aside ref={sidebar} className={`sidebar ${mobile ? "is-open" : ""}`} inert={compact && !mobile} role={mobile ? "dialog" : undefined} aria-modal={mobile ? true : undefined} aria-label={mobile ? "Navigation" : undefined}>
      <div className="brand-row"><Link href="/" className="brand" aria-label="Kivro home"><span className="brand-mark">k</span>Kivro<span className="brand-dot" /></Link><IconButton label="Close navigation" className="mobile-only" onClick={() => setMobile(false)}><X size={19} /></IconButton></div>
      <nav aria-label="Main navigation"><div className="nav-section-label">Marketplace</div>{nav(primary)}<div className="nav-section-label selling-label">Selling</div>{nav(selling)}</nav>
      <div className="sidebar-bottom"><Link href="/selling/capabilities/new" className="sell-link"><span>Put your skills to work</span><ArrowUpRight size={15} /></Link><nav aria-label="Account navigation">{nav([{ href: "/wallet", name: "Wallet", icon: Wallet }, { href: "/settings", name: "Settings", icon: Settings }])}{user?.isAdmin && nav([{ href: "/admin", name: "Administration", icon: ShieldCheck }])}</nav><div className="sidebar-footer"><span>Kivro marketplace</span><span>USD</span></div></div>
    </aside>
    <div className="workspace" inert={mobile}>
      <header className="topbar"><div className="row"><IconButton label="Open navigation" className="mobile-only" onClick={() => setMobile(true)}><Menu size={20} /></IconButton><Link href="/" className="mobile-brand" aria-label="Kivro home">Kivro<span /></Link><span className="breadcrumb-root">Workspace</span><ChevronRight className="breadcrumb-root" size={14} /><span>{current}</span></div><div className="row topbar-account">{config?.devMode && <span className="development-label">Development</span>}{user ? <><Link href="/wallet" className="wallet-shortcut"><Wallet size={16} /><span>{wallet.data ? money(wallet.data.availableMinor) : "Wallet"}</span></Link><Link className="account-avatar" href="/settings" title={user.name} aria-label={`${user.name}, account settings`}>{user.name.slice(0,2).toUpperCase()}</Link><IconButton label="Sign out" onClick={() => void logout()}><LogOut size={17} /></IconButton></> : <Button onClick={authenticate}>Sign in<ArrowUpRight size={15} /></Button>}</div></header>
      <main id="main" className="main-content" tabIndex={-1}>{children}</main>
      <footer className="workspace-footer"><span>Kivro</span><span>Independent capabilities. Real work.</span><Link href="/settings">Account</Link></footer>
    </div>
  </div>;
}
