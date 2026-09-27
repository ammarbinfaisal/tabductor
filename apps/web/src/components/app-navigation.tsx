"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  Activity, Blocks, Cable, CreditCard, Fingerprint, Menu, Monitor,
  PanelLeftClose, PanelLeftOpen, ShieldCheck, SlidersHorizontal, X,
  type LucideIcon,
} from "lucide-react";
import { createStore } from "zustand/vanilla";
import { useStoreBridge } from "../lib/store.js";
import { useMountHook } from "../lib/use-mount-hook.js";

type NavigationItem = { href: string; label: string; icon: LucideIcon };
type AppNavigationProps = {
  children: ReactNode;
  account: ReactNode;
  theme: ReactNode;
  showEndpoints: boolean;
  showAdmin: boolean;
};

const navigationStore = createStore<{
  pathname: string | null;
  collapsed: boolean;
  mobileOpen: boolean;
}>(() => ({ pathname: null, collapsed: false, mobileOpen: false }));

const workspaceItems: NavigationItem[] = [
  { href: "/workflows", label: "Workflows", icon: Blocks },
  { href: "/sessions", label: "Sessions", icon: Monitor },
  { href: "/profiles", label: "Profiles", icon: Fingerprint },
];
const settingsItems: NavigationItem[] = [
  { href: "/status", label: "Status", icon: Activity },
  { href: "/settings/models", label: "Models", icon: SlidersHorizontal },
  { href: "/billing", label: "Billing", icon: CreditCard },
];
const ownerRoutes = ["/workflows", "/sessions", "/profiles", "/endpoints", "/status", "/settings", "/billing", "/admin"];
const matchesRoute = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

function closeMobileNavigation() {
  if (!navigationStore.getState().mobileOpen) return;
  document.getElementById("app-navigation-toggle")?.focus();
  navigationStore.setState({ mobileOpen: false });
}

/** Observe Next's History API updates without the prohibited routing hooks. */
function subscribeToNavigation() {
  const syncPath = () => {
    const pathname = window.location.pathname;
    if (navigationStore.getState().pathname !== pathname) {
      closeMobileNavigation();
      navigationStore.setState({ pathname });
    }
  };
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

export function AppNavigation({ children, account, theme, showEndpoints, showAdmin }: AppNavigationProps) {
  const { pathname, collapsed, mobileOpen } = useStoreBridge(navigationStore);
  useMountHook(() => {
    const unsubscribe = subscribeToNavigation();
    const desktop = window.matchMedia("(min-width: 901px)");
    const onResize = () => closeMobileNavigation();
    desktop.addEventListener("change", onResize);
    return () => {
      unsubscribe();
      desktop.removeEventListener("change", onResize);
    };
  });

  // Fail closed until the browser path is known: share/auth pages never flash owner navigation.
  const ownerPage = pathname !== null && ownerRoutes.some(route => matchesRoute(pathname, route));
  const workspace = showEndpoints
    ? [...workspaceItems, { href: "/endpoints", label: "Endpoints", icon: Cable }]
    : workspaceItems;
  const settings = showAdmin
    ? [...settingsItems, { href: "/admin", label: "Admin", icon: ShieldCheck }]
    : settingsItems;

  const renderLinks = (items: NavigationItem[]) => items.map(({ href, label, icon: Icon }) => (
    <Link
      key={href}
      href={href}
      className="app-navigation__link"
      aria-label={label}
      aria-current={pathname !== null && matchesRoute(pathname, href) ? "page" : undefined}
      title={collapsed ? label : undefined}
      onNavigate={closeMobileNavigation}
    >
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
      <span className="app-sidebar__label">{label}</span>
    </Link>
  ));

  return (
    <div className={ownerPage ? "app-shell" : undefined} data-collapsed={collapsed}>
      {ownerPage && (
        <aside
          className="app-sidebar"
          aria-label="Application sidebar"
          data-mobile-open={mobileOpen}
          onKeyDown={event => {
            if (event.key === "Escape" && mobileOpen) {
              event.preventDefault();
              closeMobileNavigation();
            }
          }}
        >
          <div className="app-sidebar__header">
            <Link href="/workflows" className="app-sidebar__brand" aria-label="Tabductor home" onNavigate={closeMobileNavigation}>
              <svg viewBox="0 0 28 28" width="28" height="28" fill="none" aria-hidden="true">
                <path d="M4 6h20M14 6v17M6 12h5M17 17h5" stroke="currentColor" strokeWidth="2.5" />
                <circle cx="6" cy="20" r="2" fill="currentColor" />
              </svg>
              <span className="app-sidebar__label">tabductor</span>
            </Link>
            <button
              id="app-navigation-toggle"
              type="button"
              className="app-sidebar__icon-button app-sidebar__mobile-toggle"
              aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
              aria-expanded={mobileOpen}
              aria-controls="app-navigation-panel"
              onClick={() => navigationStore.setState({ mobileOpen: !mobileOpen })}
            >
              {mobileOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
            </button>
          </div>
          <div id="app-navigation-panel" className="app-sidebar__panel">
            <nav className="app-navigation" aria-label="Main navigation">
              <div className="app-navigation__group">
                <p className="app-navigation__caption app-sidebar__label">Workspace</p>
                {renderLinks(workspace)}
              </div>
              <div className="app-navigation__group">
                <p className="app-navigation__caption app-sidebar__label">Manage</p>
                {renderLinks(settings)}
              </div>
            </nav>
            <div className="app-sidebar__footer">
              <div className="app-sidebar__theme">{theme}</div>
              {account && <div className="app-sidebar__account">{account}<span className="app-sidebar__label">Your account</span></div>}
              <button
                type="button"
                className="app-sidebar__collapse"
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                aria-expanded={!collapsed}
                title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                onClick={() => navigationStore.setState({ collapsed: !collapsed })}
              >
                {collapsed ? <PanelLeftOpen size={20} aria-hidden="true" /> : <PanelLeftClose size={20} aria-hidden="true" />}
                <span className="app-sidebar__label">Collapse sidebar</span>
              </button>
            </div>
          </div>
        </aside>
      )}
      <main id="main-content" tabIndex={-1} className={ownerPage ? "app-shell__main" : undefined}>{children}</main>
    </div>
  );
}
