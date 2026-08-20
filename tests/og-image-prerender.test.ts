import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { runPrerender } from "../packages/vinext/src/build/run-prerender.js";
import { createIsolatedFixture } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/og-image-optimization");
const PNG_MAGIC_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type PrerenderManifestEntry = {
  route: string;
  status: string;
  reason?: string;
  router?: string;
};

describe("og image static optimization (issue #2950)", () => {
  let root = "";
  let manifest: { routes: PrerenderManifestEntry[] };

  beforeAll(async () => {
    // Copy the fixture to a tmpdir so build output (dist/) doesn't pollute the
    // checked-in fixture. Reuse the fixture's own node_modules (it carries the
    // workspace vinext link + react).
    root = await createIsolatedFixture(
      FIXTURE_DIR,
      "vinext-og-prerender-",
      undefined,
      path.join(FIXTURE_DIR, "node_modules"),
    );

    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [vinext({ appDir: root })],
      logLevel: "silent",
    });
    await builder.buildApp();

    // Same prerender phase `vinext build --prerender-all` runs after building.
    await runPrerender({ root, concurrency: 1 });

    manifest = JSON.parse(
      fs.readFileSync(path.join(root, "dist", "server", "vinext-prerender.json"), "utf-8"),
    );
  }, 300000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  // Expected to fail
  it.skip('prerenders a static opengraph-image without requiring "use cache"', () => {
    const entry = manifest.routes.find((r) => r.route === "/opengraph-image");
    expect(entry).toMatchObject({ status: "rendered", router: "metadata" });

    const artifactPath = path.join(
      root,
      "dist",
      "server",
      "prerendered-routes",
      "opengraph-image.route",
    );
    expect(fs.existsSync(artifactPath)).toBe(true);
    // The artifact must be the persisted ImageResponse body — a real PNG.
    const artifact = fs.readFileSync(artifactPath);
    expect(artifact.subarray(0, PNG_MAGIC_BYTES.length).equals(PNG_MAGIC_BYTES)).toBe(true);
  });

  it("serves the same opengraph-image fine as a dynamic response", async () => {
    // The route itself is fully functional — it is only excluded from the
    // prerender phase. This pins the repro to candidate enumeration
    // (getPrerenderableMetadataRoutePaths) rather than a broken route.
    const built: { default?: unknown } = await import(
      `${pathToFileURL(path.join(root, "dist", "server", "index.js")).href}?t=${Date.now()}`
    );
    expect(typeof built.default).toBe("function");
    if (typeof built.default !== "function") return;

    const res = await built.default(new Request("http://localhost/opengraph-image"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, PNG_MAGIC_BYTES.length).equals(PNG_MAGIC_BYTES)).toBe(true);
  });

  it("does not prerender a metadata image that uses request-time APIs", () => {
    // A dynamic opengraph-image (headers()) must stay dynamic: either absent
    // from the manifest or recorded as skipped — never persisted as a static
    // artifact.
    const entry = manifest.routes.find((r) => r.route === "/dynamic/opengraph-image");
    expect(entry === undefined || entry.status === "skipped").toBe(true);
    if (entry?.status === "skipped") {
      expect(entry.reason).toBe("dynamic");
    }
    expect(
      fs.existsSync(
        path.join(root, "dist", "server", "prerendered-routes", "dynamic", "opengraph-image.route"),
      ),
    ).toBe(false);
  });
});
