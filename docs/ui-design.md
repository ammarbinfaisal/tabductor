# Tabductor · Precision console

This direction supersedes the light-only Ruled Ink direction in DESIGN.md, following the September 2026 redesign request.

Purpose: make browser automation observable. Users should confidently move from a workflow brief to a running browser, intervene when necessary, and review a recording only when its session has ended.

Primary persona: Mira, an operations engineer. “Show me what my workflow is doing right now.” She needs a direct launch-to-live path, unmistakable session state, and access to browser control.

Secondary persona: Alex, a workflow author. “Let me understand the result without digging through traces.” They need legible workflow lists, restrained editing controls, and progressive disclosure of technical details.

Layout wireframes:
- Global: compact brand / primary navigation / theme preference, then a wide content canvas.
- Workflows: page title and count, prompt composer, aligned workflow rows.
- Run: breadcrumb and title, status and timing, dominant browser surface, secondary tool timeline.
- Session: status and controls, browser tabs, live viewport; terminal sessions replace that viewport with replay or a recording-unavailable state. Activity sits below.

Foundation: a 3:4 proportional scale (12, 16, 21, 28, 37, 49), a 4px spacing unit with 12/16/24/32/48px groups, and a fluid canvas capped at 1440px. Space and alignment define hierarchy; panels are reserved for working surfaces.

Typography: Space Grotesk is the geometric screen sans for headings, body and controls. IBM Plex Mono is reserved for identifiers, time and machine output. Two families; real 400/500/600/700 weights; compact headings and 1.4 UI leading.

Palette: cool graphite neutrals, near-white light surfaces, and restrained violet actions. Semantic green, blue, amber and red use text labels as redundant cues. Both themes must meet WCAG AA text contrast. System preference is the default; explicit light/dark choices persist locally and initialize before paint.

Interaction: visible keyboard focus, 44px controls, purposeful 120–200ms transitions, reduced-motion support. Mobile navigation scrolls horizontally, controls wrap, tables scroll within their container, and the browser retains a usable viewport.

Behavior contract: queued, allocating, ready, running and stopping sessions never mount a video or request an HLS playlist. Ended/failed sessions may mount replay only when a playable recording segment exists and the recording has not expired. A finished step does not imply that its shared browser session has stopped.
