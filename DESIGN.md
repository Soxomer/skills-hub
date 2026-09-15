---
name: Agent Harness Manager
description: The restored Skills Hub browser library and its Projects and Setups workspace.
colors:
  background: "#fafafa"
  surface: "#ffffff"
  surface-subtle: "#f5f5f6"
  text: "#18181b"
  text-secondary: "#6b6b72"
  border: "#dedee1"
  border-strong: "#c8c8cd"
  accent: "#2f6fed"
  accent-hover: "#255fd3"
  accent-soft: "#edf3ff"
  success: "#059669"
  success-soft: "#ecfdf5"
  warning: "#d97706"
  warning-soft: "#fff7ed"
  error: "#dc2626"
  error-soft: "#fef2f2"
  hub-element: "#f4f4f5"
  hub-border-strong: "#c9c9ce"
  hub-accent-hover: "#245ed3"
  hub-accent-soft: "#eff6ff"
typography:
  headline:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(28px, 4vw, 38px)"
    lineHeight: 1.12
    letterSpacing: "-0.035em"
  title:
    fontSize: "18px"
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  body:
    fontSize: "15px"
    lineHeight: 1.55
  label:
    fontSize: "13px"
    fontWeight: 650
  mono:
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace'
    fontSize: "12px"
  hub-title:
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "18px"
    fontWeight: 750
    lineHeight: 1.25
  hub-label:
    fontSize: "13px"
    fontWeight: 600
rounded:
  field: "6px"
  control: "8px"
  inset: "10px"
  panel: "14px"
  pill: "999px"
  hub-panel: "12px"
  hub-navigation: "9px"
spacing:
  tight: "8px"
  related: "12px"
  group: "16px"
  section: "24px"
  wide: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "0 15px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "0 11px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "0 11px"
  navigation-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.hub-navigation}"
    padding: "0 10px"
    height: "38px"
  hub-button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "36px"
  hub-button-primary-hover:
    backgroundColor: "{colors.hub-accent-hover}"
  skill-card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.hub-panel}"
    padding: "14px"
  status-chip:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
    padding: "24px"
---

# Design System: Agent Harness Manager

## Overview

**Creative North Star: "The Compact Utility Workspace"**

The established interface is neutral, calm, and quietly confident. Alignment, readable task hierarchy, and compact controls carry the design; color identifies action or operational state. This name describes the existing implementation rather than introducing a brand direction.

This records the restored Skills Hub browser experience and the preserved Projects and Setups workspace. It is grounded in `PRODUCT.md`, `docs/UI-DESIGN-GUIDELINES.md`, the runtime styles, and the restored React components. The restoration follows the original compact sidebar and management interface, including preview before installation; it introduces no new visual direction.

Runtime CSS remains the implementation authority. Frontmatter records the light baseline. Skills Hub uses the `App.css` semantic variables and its system/light/dark preference; the Projects and Setups workspace retains the `index.css` variables. The `hub-` entries capture observed differences between these existing component families. Existing headline, button, input, and panel tokens remain applicable to the Projects and Setups workspace.

**Key Characteristics:**

- Flat surfaces, subtle boundaries, and restrained rounding.
- Compact sidebar navigation, structured skill lists, and optional card views.
- One blue action accent and semantic status colors.
- Visible prerequisites and honest operation states.
- Contextual skill previews before an explicit installation action.

## Colors

The palette combines near-white workspace surfaces, charcoal text, quiet gray boundaries, and an action blue.

### Primary

- **Action blue:** accent for forward actions, focused controls, and current navigation; its soft companion marks selection and contextual icons.

### Neutral

- **Workspace white, panel white, and inset gray:** distinguish the workspace, containers, and table headers without shadows.
- **Charcoal and secondary gray:** separate content from descriptions, timestamps, and metadata.
- **Subtle and strong gray borders:** resting separation and hover emphasis.

Success green, warning amber, and error red are operational signals with corresponding soft backgrounds. Pair state color with readable text or an icon.

**The Semantic Color Rule.** Use runtime variables and their dark bindings; never add decorative colors where an existing semantic role applies.

## Typography

Use the UI sans-serif stack for interface text. Skills Hub management titles use the hub-title role, compact controls use the hub-label role, and sidebar labels use (14px). Compact operational copy commonly uses (12–14px); metadata commonly uses (11–12px). Summary values use (26px), reducing to (22px) on narrower layouts. Projects and Setups retain the headline, title, and body roles; do not apply their large page headings to compact library rows.

Use the monospace stack for paths, commands, versions, and digests. Establish hierarchy through weight, contrast, and spacing. Lucide icons clarify actions and objects; icon-only controls need accessible labels.

## Layout

Skills Hub uses a persistent left sidebar and an independently scrolling content region. The desktop sidebar is (228px), reducing to (196px) at (1120px); the collapsed rail is (64px). Content padding is normally (24px), with smaller clearances as space decreases. The restored browser hides the former desktop window controls. The library opens with four summary tiles, a compact search/filter/action row, and structured skill rows or cards.

At (600px) and below, the sidebar automatically becomes the (64px) icon rail without changing the saved desktop collapse preference. The main content uses (12px) padding, summary tiles form two columns, and filters wrap. List rows reflow identity, metadata, enable control, tool targets, and actions across separate lines; action buttons become (36px). Card and catalogue grids reduce to one column. Keep primary actions reachable and allow long skill names to wrap.

The Projects & runner navigation opens the separate preserved workspace for project connection, inspection, and Setup workflows. That workspace retains its sticky top bar and centered content capped at (960px), with (24px) side clearance and (54px) top padding. At (720px), side clearance becomes (14px), top padding becomes (34px), and headings stack. This workspace pattern does not replace the Skills Hub sidebar.

## Elevation & Depth

Resting content uses borders and tonal layering. The restored sidebar selection and card hover use a small shadow; primary actions have a restrained accent shadow. Temporary drawers, menus, and dialogs carry stronger elevation. The Projects and Setups top bar retains a nearly opaque surface mix and backdrop blur (12px). Keep the existing subtle exceptions without adding elevated containers around ordinary content.

The light-theme small shadow is `0 1px 2px 0 rgb(0 0 0 / 0.05)`; the overlay shadow is `0 10px 20px -6px rgb(0 0 0 / 0.15)`. Dialogs also use `0 18px 48px rgb(0 0 0 / .24)`. Dark bindings and component-specific motion are recorded in the sidecar or runtime CSS.

## Shapes

Controls use restrained rounding. Hub cards, summary tiles, and dialogs use the hub-panel radius; navigation uses the hub-navigation radius. Inset notices and command blocks retain the inset radius, while Projects and Setups workflow panels retain the panel radius. Status chips and enable switches use pill geometry. Borders are thin (1px); extra enclosing panels should represent an actual grouping or interaction boundary.

## Components

### Buttons

Skills Hub buttons are normally (36px) high with compact labels. Primary hover deepens the accent and moves up (1px); secondary hover strengthens the border and uses the subtle surface. Hub buttons transition over (200ms); cards use (150ms). Projects and Setups retain primary buttons with a (40px) minimum height, secondary buttons with a (34px) minimum height, and (140ms) transitions. Disabled controls use reduced opacity and an unavailable cursor. Relevant prerequisites belong nearby.

### Inputs / Fields

Fields use neutral surfaces and borders with visible accent focus. The Hub search is (42px) high, fills available toolbar space, and moves to its own line on narrow screens. Its filter and view controls remain compact. Projects and Setups fields retain a (40px) minimum height and the existing focus outline. Preserve accessible labels for search, filters, and icon controls.

### Navigation

The sidebar groups My Skills, Add Skills, and Projects & runner above Tags, Tools, and Updates, with Settings anchored below. Resting labels are muted; hover uses a subtle neutral fill. Selection uses a bordered panel surface, stronger text, and a blue icon. Expanded navigation shows labels and useful counts. Collapsed navigation keeps icons, active state, and accessible names while hiding labels and counts. The saved desktop preference resumes when leaving the narrow viewport.

### Chips and panels

Chips carry compact status metadata and pair semantic backgrounds with text. Workflow panels use a surface and border, typically (24px) padding, reduced to (18px) on narrow screens. Discovery rows and Setup lists retain scanning alignment and subtle hover surfaces.

### Managed skills library

My Skills is the restored management surface: search, scope and tag filters, sort, list/card switching, enable controls, tool sync, tags, refresh, and delete actions share compact rows. Bulk actions preserve the same scanning hierarchy. Keep disabled skills, selected rows, sync state, empty results, loading, and errors visibly distinct. The browser presents these controls through the local ahm worker; only that worker changes local files. Viewing the library does not change project assignments or saved Setups.

### Catalogue, preview, and import

Add Skills exposes catalogue discovery and import entry points. A catalogue preview opens a right-hand contextual drawer showing skill identity, source, description, and readable SKILL.md content before the user installs. Keep its explicit preview-only message and separate Install action visible. The drawer has its own scrollable content, close control, and footer; loading and failure states stay inside it. Desktop width is bounded by (680px); at (820px) and below it fills the viewport except for a (24px) context strip. Its existing (180ms) entry motion is disabled under reduced motion. Local and Git import dialogs retain source selection, candidate review, scope, and tool-target choices.

### Management and Setup workflows

Tags, Tools, Updates, and Settings retain the original compact management layouts and direct action labels. Projects and Setups remain additional workflows with review, immutable history, and deliberate Apply actions. A runner report may be read-only within those workflows, but that does not make the managed My Skills library read-only. Show connection prerequisites next to affected actions. The browser experience has no Tauri dependency or direct filesystem mutation.

## Do's and Don'ts

### Do:

- **Do** reuse semantic CSS variables in both themes.
- **Do** preserve compact scanning, visible labels, and keyboard focus.
- **Do** keep state explanations next to the data or action they qualify.
- **Do** keep English product copy in the resource bundle and respect reduced motion.

### Don't:

- **Don't** replace management density with oversized marketing cards.
- **Don't** use status color as decoration or the sole state indicator.
- **Don't** add containers without a meaningful grouping boundary.
- **Don't** replace the managed library with a read-only report or conflate it with saved Setups.
- **Don't** install a catalogue skill merely because its preview was opened.
- **Don't** reintroduce Tauri window controls or browser filesystem mutation.
