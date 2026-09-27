import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { clerkConfigured, clerkPublishableKey } from "./server/clerk-config.js";

const configured = clerkConfigured();
const isPublicRoute = createRouteMatcher(["/pricing", "/s/(.*)", "/status", "/api/mcp", "/api/profile-import", "/sign-in(.*)", "/sign-up(.*)", "/api/paddle/webhook"]);

const authenticated = clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) await auth.protect();
}, { publishableKey: clerkPublishableKey(), signInUrl: "/sign-in", signUpUrl: "/sign-up" });

const unauthenticated = () => {
  if (process.env.NODE_ENV === "production" && process.env.TABDUCTOR_FIXTURE_MODE !== "1") {
    return new NextResponse("Authentication is not configured", { status: 503 });
  }
  return NextResponse.next();
};

export default configured ? authenticated : unauthenticated;

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
