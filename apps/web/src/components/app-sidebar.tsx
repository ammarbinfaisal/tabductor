"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  Activity, Blocks, Cable, CreditCard, Fingerprint, Monitor,
  PanelLeftClose, PanelLeftOpen, ShieldCheck, SlidersHorizontal, SunMoon, Workflow,
  type LucideIcon,
} from "lucide-react";
import { createStore } from "zustand/vanilla";
import { useStoreBridge } from "../lib/store.js";
import { useMountHook } from "../lib/use-mount-hook.js";

type NavigationItem = { href: string; label: string; icon: LucideIcon };
type AppSidebarProps = {
  children: ReactNode;
  account: ReactNode;
  theme: ReactNode;
  showEndpoints: boolean;
  showAdmin: boolean;
};

const sidebarStore = createStore<{ pathname: string | null; collapsed: boolean }>(
  () => ({ pathname: null, collapsed: false }),
);
const storageKey = "tabductor.sidebar.collapsed";
const workspaceItems: NavigationItem[] = [
  { href: "/workflows", label: "Workflows", icon: Blocks },

  { href: "/profiles", label: "Profiles", icon: Fingerprint },
];
const manageItems: NavigationItem[] = [

  { href: "/settings/models", label: "Models", icon: SlidersHorizontal },
  { href: "/billing", label: "Billing", icon: CreditCard },
];
const ownerRoutes = ["/workflows", "/sessions", "/profiles", "/endpoints", "/status", "/settings", "/billing", "/admin"];
const matchesRoute = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

/** Next updates history on client transitions; routing hooks are disallowed by the web hook policy. */
function subscribeToLocation() {
  const syncPath = () => sidebarStore.setState({ pathname: window.location.pathname });
  const originalPush = window.history.pushState;
  const originalReplace = window.history.replaceState;
  const pushState: History["pushState"] = function (...args) {
    originalPush.apply(window.history, args);
    syncPath();
  };
  const replaceState: History["replaceState"] = function (...args) {
    originalReplace.apply(window.history, args);
    syncPath();
  };
  window.history.pushState = pushState;
  window.history.replaceState = replaceState;
  window.addEventListener("popstate", syncPath);
  window.addEventListener("pageshow", syncPath);
  syncPath();
  return () => {
    if (window.history.pushState === pushState) window.history.pushState = originalPush;
    if (window.history.replaceState === replaceState) window.history.replaceState = originalReplace;
    window.removeEventListener("popstate", syncPath);
    window.removeEventListener("pageshow", syncPath);
  };
}

function toggleSidebar() {
  const collapsed = !sidebarStore.getState().collapsed;
  sidebarStore.setState({ collapsed });
  try { localStorage.setItem(storageKey, String(collapsed)); } catch { /* Storage is optional. */ }
}

export function AppSidebar({ children, account, theme, showEndpoints, showAdmin }: AppSidebarProps) {
  const { pathname, collapsed } = useStoreBridge(sidebarStore);
  useMountHook(() => {
    try { sidebarStore.setState({ collapsed: localStorage.getItem(storageKey) === "true" }); } catch { /* Keep the default. */ }
    const unsubscribe = subscribeToLocation();
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) sidebarStore.setState({ collapsed: event.newValue === "true" });
    };
    window.addEventListener("storage", onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener("storage", onStorage);
    };
  });

  // Public/auth pages never briefly expose owner navigation while the path initializes.
  const ownerPage = pathname !== null && ownerRoutes.some(route => matchesRoute(pathname, route));
  const workspace = workspaceItems;
  const baseManage = showEndpoints ? [...manageItems, { href: "/endpoints", label: "Endpoints", icon: Cable }] : manageItems;
  const manage = showAdmin
    ? [...baseManage, { href: "/admin", label: "Admin", icon: ShieldCheck }]
    : baseManage;
  const brand = (
    <Link href="/" className="app-sidebar__brand" aria-label="Tabductor home" title="Tabductor home">
      <span className="app-sidebar__mark"><Workflow size={22} strokeWidth={1.75} aria-hidden="true" /></span>
      <span className="app-sidebar__label">tabductor</span>
    </Link>
  );
  const themeControl = (
    <div className="app-sidebar__theme" title="Color theme">
      <SunMoon size={18} strokeWidth={1.75} aria-hidden="true" />
      {theme}
    </div>
  );
  const renderGroup = (label: string, items: NavigationItem[]) => (
    <div className="app-sidebar__group" role="group" aria-label={label}>
      <p className="app-sidebar__caption app-sidebar__label" aria-hidden="true">{label}</p>
      {items.map(({ href, label: itemLabel, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className="app-sidebar__link"
          aria-label={itemLabel}
          aria-current={pathname !== null && matchesRoute(pathname, href) ? "page" : undefined}
          title={itemLabel}
        >
          <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
          <span className="app-sidebar__label">{itemLabel}</span>
        </Link>
      ))}
    </div>
  );

  return (
    <div className={ownerPage ? "app-shell" : "app-public-shell"} data-collapsed={collapsed}>
      {ownerPage ? (
        <aside className="app-sidebar" aria-label="Application sidebar">
          <div className="app-sidebar__header">{brand}</div>
          <nav id="app-sidebar-navigation" className="app-sidebar__navigation" aria-label="Main navigation">
            {renderGroup("Monitor", [{ href: "/sessions", label: "Sessions", icon: Monitor }, { href: "/status", label: "Status", icon: Activity }])}
            {renderGroup("Build", workspace)}
            {renderGroup("Manage", manage)}
          </nav>
          <footer className="app-sidebar__footer">
            {themeControl}
            {account && (
              <div className="app-sidebar__account">
                {account}
                <span className="app-sidebar__label">Your account</span>
              </div>
            )}
            <button
              type="button"
              className="app-sidebar__collapse"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              aria-controls="app-sidebar-navigation"
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={toggleSidebar}
            >
              {collapsed ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />}
              <span className="app-sidebar__label">Collapse sidebar</span>
            </button>
          </footer>
        </aside>
      ) : (
        <header className="app-public-header">{brand}{themeControl}</header>
      )}
      <main id="main-content" tabIndex={-1} className={ownerPage ? "app-shell__main" : undefined}>{children}</main>
    </div>
  );
}
