# Frontend UI and theme contract

Read this before adding or changing Studio UI. The theme contract and eight
regions are documented in [theme customization](../theme-customization.md).
The UI must work with a wallpaper, regional overrides and a reset to presets.

## Own each surface

- Use existing layout and Naive UI components. Put shared library overrides in
  `packages/client/src/styles/theme.ts`; do not set local `--n-color`, table fills
  or Switch rail fills to work around them.
- A new native card uses `data-theme-surface="card"`. Native input/segmented
  controls use `data-theme-surface="input"`. These are the two supported opt-in
  attributes, not eight arbitrary attribute values. Other regions are mapped in
  `_theme-surfaces.scss`; extend the map and verify it when adding another shell,
  sidebar, content, overlay or message surface.
- The attribute owns custom background, alpha, blur, radius, borders and shadow.
  It also supplies the wallpaper background without requiring a local fallback.
  A shared `$bg-card` preset is fine on a registered card. A bare preset background
  on an unregistered container is not sufficient: it cannot follow regional alpha.
- Use shared text, border and accent tokens. Ordinary borders inherit regional
  opacity; active, focus, error and disabled states must remain distinguishable.
- Paint a translucent surface once. Nested labels, table row groups and ordinary
  wrappers stay transparent; hover/selection may add a semantic translucent tint.
  Never implement surface transparency with container `opacity`, which also dims
  text and children. Keep layout/width/alignment separate from appearance.
- Native Teleport menus must be covered by the overlay map. Canvas, editor and
  isolated-frame content needs an explicit adapter. Preserve the chrome's shared
  background layer and the content/card backdrop-root separation.

```vue
<template>
  <section class="route-card" data-theme-surface="card">...</section>
</template>
<style scoped lang="scss">
@use '@/styles/variables' as *;
.route-card {
  background: $bg-card;
  color: $text-primary;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
}
</style>
```

Do not add `!important` or broad descendant overrides to beat the theme. Reuse
its region mapping or fix the library adapter. Explicit `var(--theme-card-bg,
...)` fills are also supported for shared styles, but the owning surface still
needs the region's filter, border, radius and shadow behavior.

## Mechanical checks

`npm run harness:check` runs `scripts/ui-theme-harness.mjs` in local development
and the existing Build workflow. It scans the current client tree, including
untracked files, without needing Git history or an application server. Vue/SCSS
and TypeScript parsers inspect declarations, static inline styles and literal
values in bound style objects/scripts; comments and unrelated string text do not
count as styles.

The checker rejects:

- New backgrounds that bypass a region, registered card/input, or semantic state.
- Literal hex/RGB/HSL colors and common named colors in text, fills, borders,
  outlines and shadows. Token fallbacks remain allowed.
- Local Naive UI fill-variable overrides, even when using a preset token.
- Container opacity on registered surfaces, except interactive state rules.
- Inline background fills on registered surfaces, which outrank the shared CSS.
- Unknown/dynamic surface attributes and malformed or unused style exceptions.

`ui-theme-baseline.json` records existing findings by file, selector/property/value
and count. This is a migration inventory, **not an approved component palette or
a list of visual bugs**: it includes historical semantic colors, artwork, adapter
styles and surfaces already mapped by global selectors. It permits only those
exact existing declarations. New files, changed values and extra copies fail.
Removed findings must be removed from the baseline. **Do not regenerate or expand
this baseline to make new UI pass**; fix new code or justify a local exception.

There are four narrow infrastructure exemptions: palette variables, the CSS
appearance resolver, Naive UI theme adapter and regional surface stylesheet.
Changes there require the theme regression suite. Do not expand this exemption
list for business UI.

Static checks cannot prove visual correctness or resolve arbitrary runtime
expressions, generated HTML, external documents, CSS cascade or backdrop sampling.
They do not replace browser verification, and passing does not establish that an
old baseline surface is fully themed.

## Intentional colors

QR quiet zones, artwork, semantic data colors, authored external content and theme
swatch previews may require fixed colors. Prefer shared semantic tokens first.
When a fixed declaration is necessary, place a comment immediately before that
one declaration, including a category and a concrete reason (at least 12 chars):

```scss
.qr-code {
  /* theme-exception: qr -- Opaque quiet zone is required for reliable scanning. */
  background: #fff;
}
```

Allowed categories: `artwork`, `semantic`, `external`, `qr`, `preview`, `state`.
The same comment format works before a literal property in a script style object.
It never exempts a file, selector or child subtree. Blank reasons, comments before
an entire rule and exceptions on declarations with no finding fail. Reviewers
must assess the stated reason; do not use exceptions for ordinary cards/controls.
Move inline styles to scoped SCSS if they need a documented exception.

## Verification before completion

For UI changes, inspect the **actual affected surface**, including populated,
loading/disabled and empty states where relevant:

1. Light and dark presets, with and without wallpaper.
2. Global opacity and a different regional opacity, including zero; ordinary
   borders follow the region while text and focus/selection remain legible.
3. Regional color/blur/radius, inheritance reset and removal of wallpaper.
4. Teleported menus/dialogs and narrow layout; verify controls still work.

Use the relevant existing `tests/e2e/theme-*.spec.ts` suites and browser mocks.
Add focused regression coverage for a shared theme behavior change or a new
adapter; do not add a source-string test for each cosmetic edit. Run the build and
harness. Changes to this checker need `tests/client/ui-theme-harness.test.ts`,
including negative cases proving invalid UI is actually rejected.
