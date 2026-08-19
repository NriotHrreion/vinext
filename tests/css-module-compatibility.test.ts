/**
 * Reproduction for https://github.com/cloudflare/vinext/issues/2992
 *
 * CSS Modules + postcss-extend-rule: `@extend` is silently dropped because
 * Vite's compileCSS() puts the CSS-Modules plugin at the FRONT of the PostCSS
 * plugin chain:
 *
 *   if (isModule) postcssPlugins.unshift((await importPostcssModules()).default({ ... }))
 *
 * so class names are already hashed (`.shared` -> `._shared_1u9uh_1`) by the
 * time the project's PostCSS plugins run. `@extend .shared` then matches no
 * rule, and postcss-extend-rule silently removes the at-rule (its default
 * `onUnusedExtend` behavior) — no warning, no error, in dev and in the
 * production build alike.
 *
 * Next.js (webpack/css-loader) runs the project's PostCSS plugins BEFORE
 * CSS-module scoping, so the same stylesheet works under `next build`. That
 * ordering is the parity target for vinext.
 *
 * Fixture: tests/fixtures/css-module-compatibility — an App Router app whose
 * root layout imports app/styles.module.css:
 *
 *   .shared { position: absolute; }
 *   .wrap   { @extend .shared; color: red; }
 *
 * with postcss.config.mjs = { plugins: { "postcss-extend-rule": {} } }
 * (object form, loaded by Vite's own postcss-load-config).
 */

import { describe, it, expect, beforeAll } from "vite-plus/test";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { buildAppFixture } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/css-module-compatibility");

async function readAllCss(dir: string): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  const texts: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".css")) continue;
    const parent =
      (entry as { parentPath?: string; path?: string }).parentPath ??
      (entry as { path?: string }).path ??
      dir;
    texts.push(await fs.readFile(path.join(parent, entry.name), "utf8"));
  }
  return texts.join("\n");
}

/**
 * Bodies of every style rule whose selector mentions `classToken` — for
 * source CSS use ".wrap"; for built CSS use the hashed "_wrap_" infix.
 */
function ruleBodiesForClass(css: string, classToken: string): string[] {
  const bodies: string[] = [];
  const re = new RegExp(`[^{}]*${classToken}[^{}]*\\{([^}]*)\\}`, "g");
  for (const match of css.matchAll(re)) {
    if (match[1]) bodies.push(match[1]);
  }
  return bodies;
}

describe("CSS Module PostCSS plugin ordering (issue #2992)", () => {
  // Fixture sanity, straight from the issue report: "Running the same
  // PostCSS config standalone over the same file resolves the extend
  // correctly, so the configuration is fine — only the ordering inside
  // Vite's pipeline is wrong." postcss runs the plugin against the ORIGINAL
  // selectors here, which is the css-loader/Next.js order.
  it("resolves @extend when the fixture PostCSS config runs standalone", async () => {
    const fixtureRequire = createRequire(path.join(FIXTURE_DIR, "package.json"));
    const postcss = fixtureRequire("postcss");
    const extendRule = fixtureRequire("postcss-extend-rule");
    const cssPath = path.join(FIXTURE_DIR, "app", "styles.module.css");
    const source = await fs.readFile(cssPath, "utf8");

    const result = await postcss([extendRule()]).process(source, { from: cssPath });

    // postcss-extend-rule copies the extended rule's declarations into the
    // extending rule: .wrap gains its own rule with `position: absolute`.
    expect(result.css).not.toContain("@extend");
    const wrapBodies = ruleBodiesForClass(result.css, ".wrap");
    expect(wrapBodies.some((body) => /position:\s*absolute/.test(body))).toBe(true);
  });

  describe("vinext build output", () => {
    let css = "";

    beforeAll(async () => {
      const rscBundlePath = await buildAppFixture(FIXTURE_DIR);
      const outDir = path.dirname(path.dirname(rscBundlePath));
      css = await readAllCss(outDir);
    }, 180_000);

    it("runs both PostCSS stages on the CSS module (classes hashed, @extend consumed)", () => {
      // CSS-module scoping ran: class names are hashed.
      expect(css).toMatch(/_shared_/);
      expect(css).toMatch(/_wrap_/);
      // postcss-extend-rule ran too — it removed the at-rule even though it
      // could not match anything (default onUnusedExtend drops it silently).
      expect(css).not.toContain("@extend");
      // The extending rule kept its own declarations.
      expect(ruleBodiesForClass(css, "_wrap_").some((body) => /color:\s*red/.test(body))).toBe(
        true,
      );
    });

    // Characterizes the bug. When the ordering is fixed, this expectation
    // inverts — remove this test and unskip the parity test below.
    it("reproduces #2992: @extend inherits nothing because hashing ran first", () => {
      // `.wrap` should inherit `position: absolute` from `.shared`, but
      // postcss-extend-rule only saw the hashed selectors (`._shared_…`), so
      // `@extend .shared` matched nothing and the declarations were lost.
      expect(
        ruleBodiesForClass(css, "_wrap_").some((body) => /position:\s*absolute/.test(body)),
      ).toBe(false);
    });

    // SKIP / parity target: Next.js (webpack/css-loader) runs the project's
    // PostCSS plugins before CSS-module scoping, so `@extend .shared`
    // resolves against the original class names and .wrap inherits
    // `position: absolute`.
    //
    // ROOT CAUSE: Vite's compileCSS() unshifts the CSS-Modules plugin ahead
    // of the project's PostCSS plugins (vite/src/node/plugins/css.ts), so
    // user plugins always run on already-hashed selectors.
    //
    // TO FIX: run the project's PostCSS plugins before CSS-module scoping —
    // e.g. pre-expand @extend in an enforce:"pre" transform, or take over
    // CSS-module handling with a plugin like vite-css-modules that applies
    // user PostCSS first (see the issue discussion).
    //
    // VERIFY: unskip this test; it should pass without fixture changes, and
    // the characterization test above should then be removed.
    it.skip("resolves @extend before CSS-module scoping (Next.js parity)", () => {
      expect(
        ruleBodiesForClass(css, "_wrap_").some((body) => /position:\s*absolute/.test(body)),
      ).toBe(true);
    });
  });
});
