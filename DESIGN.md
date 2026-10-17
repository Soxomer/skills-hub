---
name: Agent Harness Manager
description: A compact Skills Hub workspace for managed skills, versioned Setups, and projects.
colors:
  background: "#fafafa"
  surface: "#ffffff"
  surface-subtle: "#f4f4f5"
  text: "#18181b"
  text-secondary: "#6b6b72"
  border: "#dedee1"
  border-strong: "#c9c9ce"
  accent: "#2f6fed"
  accent-hover: "#245ed3"
  accent-soft: "#eff6ff"
  success: "#059669"
  success-soft: "#ecfdf5"
  warning: "#d97706"
  warning-soft: "#fffbeb"
  error: "#dc2626"
  error-soft: "#fef2f2"
  hub-element: "#f4f4f5"
  hub-border-strong: "#c9c9ce"
  hub-accent-hover: "#245ed3"
  hub-accent-soft: "#eff6ff"
typography:
  headline:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "24px"
    lineHeight: 1.3
    letterSpacing: "-0.02em"
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

This records one Skills Hub browser workspace for the managed library, saved Setups, Projects, and Computer inventory. The existing compact sidebar and management interface continue across these destinations, including preview before installation and deliberate review before Apply. It is grounded in `PRODUCT.md`, the runtime styles, and the integrated React components; the visual identity remains unchanged.

Runtime CSS remains the implementation authority. Frontmatter records the light baseline. The shared system/light/dark preference controls the entire workspace through `App.css` semantic variables. Integrated Projects and Setups alias their surface, text, border, accent, and status roles to these same variables. The `hub-` entries preserve component-family names; they do not define a separate theme. Workflow buttons, fields, and panels retain their established dimensions, with compact workspace headings.

**Key Characteristics:**

- Flat surfaces, subtle boundaries, and restrained rounding.
- One persistent sidebar, structured skill lists, and optional card views.
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

Use the UI sans-serif stack for interface text. Skills Hub management titles use the hub-title role, compact controls use the hub-label role, and sidebar labels use (14px). Compact operational copy commonly uses (12–14px); metadata commonly uses (11–12px). Summary values use (26px), reducing to (22px) on narrower layouts. Projects, Setups, and evaluation use the compact headline role (24px); section headings and supporting copy remain subordinate. Evaluation section headings use (17px), field and comparison labels use (13px), and version identities use weight (600).

Use the monospace stack for paths, commands, versions, and digests. Establish hierarchy through weight, contrast, and spacing. Lucide icons clarify actions and objects; icon-only controls need accessible labels.

## Layout

Skills Hub uses a persistent left sidebar and an independently scrolling content region. The desktop sidebar is (228px), reducing to (196px) at (1120px); the collapsed rail is (64px). Content padding is normally (24px), with smaller clearances as space decreases. The restored browser hides the former desktop window controls. The library opens with four summary tiles, a compact search/filter/action row, and structured skill rows or cards.

At (600px) and below, the sidebar automatically becomes the (64px) icon rail without changing the saved desktop collapse preference. The main content uses (12px) padding, summary tiles form two columns, and filters wrap. List rows reflow identity, metadata, enable control, tool targets, and actions across separate lines; action buttons become (36px). Card and catalogue grids reduce to one column. Keep primary actions reachable and allow long skill names to wrap.

Projects and Setups open directly within the same sidebar and scrolling main region. A shared connection strip remains above every destination. Workflow content is left-aligned, fills available width up to (1200px), and has (40px) bottom clearance; it adds no second top bar or nested navigation shell. At (720px), workflow headings and actions stack. Evaluation pairs versions, model settings, and fixed settings in two columns with (20px) row and (32px) column gaps, stacking at (640px); result columns adapt to available width with a (260px) minimum where space allows.

**The One Workspace Rule.** Keep global navigation and connection status in the shared shell; use contextual Back controls inside a task.

## Elevation & Depth

Resting content uses borders and tonal layering. The restored sidebar selection and card hover use a small shadow; primary actions have a restrained accent shadow. Temporary drawers, menus, and dialogs carry stronger elevation. The shared connection strip uses a bottom border; integrated workflow sections remain flat. Keep the existing subtle exceptions without adding elevated containers around ordinary content.

The light-theme small shadow is `0 1px 2px 0 rgb(0 0 0 / 0.05)`; the overlay shadow is `0 10px 20px -6px rgb(0 0 0 / 0.15)`. Dialogs also use `0 18px 48px rgb(0 0 0 / .24)`. Dark bindings and component-specific motion are recorded in the sidecar or runtime CSS.

## Shapes

Controls use restrained rounding. Hub cards, summary tiles, and dialogs use the hub-panel radius; navigation uses the hub-navigation radius. Inset notices and command blocks retain the inset radius, while Projects and Setups workflow panels retain the panel radius. Status chips and enable switches use pill geometry. Borders are thin (1px); extra enclosing panels should represent an actual grouping or interaction boundary.

## Components

### Buttons

Skills Hub buttons are normally (36px) high with compact labels. Primary hover deepens the accent and moves up (1px); secondary hover strengthens the border and uses the subtle surface. Hub buttons transition over (200ms); cards use (150ms). Projects and Setups retain primary buttons with a (40px) minimum height, secondary buttons with a (34px) minimum height, and (140ms) transitions. Disabled controls use reduced opacity and an unavailable cursor. Relevant prerequisites belong nearby.

### Inputs / Fields

Fields use neutral surfaces and borders with visible accent focus. The Hub search is (42px) high, fills available toolbar space, and moves to its own line on narrow screens. Its filter and view controls remain compact. Projects and Setups fields retain a (40px) minimum height and the existing focus outline. Preserve accessible labels for search, filters, and icon controls.

### Navigation

The sidebar exposes My Skills, Add Skills, Setups, and Projects directly. Its management group contains Tags, Tools, Updates, and Computer inventory, with Settings anchored below. Resting labels are muted; hover uses a subtle neutral fill. Selection uses a bordered panel surface, stronger text, and a blue icon. Expanded navigation shows labels and useful counts. Collapsed navigation keeps icons, active state, and accessible names while hiding labels and counts. The saved desktop preference resumes when leaving the narrow viewport. Current destinations expose `aria-current`, and a keyboard skip link targets the main content. Setups and Projects remain mounted once visited so navigation retains drafts and task selections; relevant server reads refresh on reentry, while an active editor, evaluation, or destination flow keeps its exact loaded revision.

### Chips and panels

Chips carry compact status metadata and pair semantic backgrounds with text. Workflow panels use a surface and border, typically (24px) padding, reduced to (18px) on narrow screens. Discovery rows and Setup lists retain scanning alignment and subtle hover surfaces.

### Managed skills library

My Skills is the restored management surface: search, scope and tag filters, sort, list/card switching, enable controls, tool sync, tags, refresh, and delete actions share compact rows. Bulk actions preserve the same scanning hierarchy. Keep disabled skills, selected rows, sync state, empty results, loading, and errors visibly distinct. The browser presents these controls through the local ahm worker; only that worker changes local files. Viewing the library does not change project assignments or saved Setups.

### Catalogue, preview, and import

Add Skills exposes catalogue discovery and import entry points. A catalogue preview opens a right-hand contextual drawer showing skill identity, source, description, and readable SKILL.md content before the user installs. Keep its explicit preview-only message and separate Install action visible. The drawer has its own scrollable content, close control, and footer; loading and failure states stay inside it. Desktop width is bounded by (680px); at (820px) and below it fills the viewport except for a (24px) context strip. Its existing (180ms) entry motion is disabled under reduced motion. Local and Git import dialogs retain source selection, candidate review, scope, and tool-target choices.

### Management and Setup workflows

Tags, Tools, Updates, and Settings retain compact management layouts and direct action labels. Computer inventory is a read-only runner report; My Skills remains the managed library with its existing actions. Saved Setups are browsable without an online computer. Their version selector, content inspection, edit/clone, comparison, and project-use actions retain visible identity and immutable history. Returning from an added skill opens the exact saved Setup revision. Publishing and evaluation leave project assignments unchanged; using a Setup on a project leads to a separate reviewed Apply. Show connection prerequisites next to affected actions. The browser experience has no Tauri dependency or direct filesystem mutation.

### Setup evaluation

Comparison is a contextual task under Setups, with a Back control, exact candidate identity, a selectable baseline version, and plainly labeled sections for versions, shared settings, and execution. The fixed-settings inset shows Codex, captured SKILL.md instructions, a read-only sandbox, and one trial per version with a (120-second) timeout. Model and reasoning effort are editable fields; fixed conditions are readable metadata. Show the instructions-only scope before the form, place fixture and execution details in disclosures, and keep consent and a specific prerequisite list beside the Start action.

History uses a readable run heading, timestamp, execution status, shared profile, and paired baseline/candidate results. Each side shows version identity, outcome, duration, and check totals; technical identifiers and observed runtime details sit in a disclosure. Failures and timeouts remain distinct from task checks. Preserve the preliminary-evidence limitation and the separate Apply action; the interface must not imply a general ranking or project-level test.

**The Exact Version Rule.** Keep the selected Setup revision visible and stable through inspection, comparison, and project handoff; a refresh must not silently substitute a newer version.

## Do's and Don'ts

### Do:

- **Do** reuse semantic CSS variables in both themes.
- **Do** preserve compact scanning, visible labels, and keyboard focus.
- **Do** keep state explanations next to the data or action they qualify.
- **Do** preserve task drafts across navigation while refreshing relevant server data on reentry.
- **Do** show exact versions and separate publication, evaluation, and reviewed Apply.
- **Do** keep English product copy in the resource bundle and respect reduced motion.

### Don't:

- **Don't** replace management density with oversized marketing cards.
- **Don't** use status color as decoration or the sole state indicator.
- **Don't** add containers without a meaningful grouping boundary.
- **Don't** replace the managed library with Computer inventory or conflate it with saved Setups.
- **Don't** add a second navigation shell or independent theme for Projects and Setups.
- **Don't** present the fixed instructions-only comparison as native skill discovery or a general performance ranking.
- **Don't** install a catalogue skill merely because its preview was opened.
- **Don't** reintroduce Tauri window controls or browser filesystem mutation.
