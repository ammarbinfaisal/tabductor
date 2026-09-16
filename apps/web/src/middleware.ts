import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const configured = Boolean(process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
const isPublicRoute = createRouteMatcher(["/s/(.*)", "/status", "/api/mcp"]);

const authenticated = clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) await auth.protect();
});

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
