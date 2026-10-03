import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SightingMarkdown } from "@/components/ui/sighting-markdown";

const render = (markdown: string, trustedImages = false) =>
  renderToStaticMarkup(createElement(SightingMarkdown, { markdown, trustedImages }));

describe("SightingMarkdown (public text)", () => {
  it("renders an image from an allowed host", () => {
    const html = render("![rat](https://image.tmdb.org/t/p/w500/a.jpg)");
    expect(html).toContain('<img src="https://image.tmdb.org/t/p/w500/a.jpg"');
  });

  it("renders a site-relative image", () => {
    expect(render("![rat](/uploads/sightings/a.png)")).toContain('src="/uploads/sightings/a.png"');
  });

  it.each([
    "![t](http://evil.example/p.png)",
    "![t](https://evil.example/p.png)",
    "![t](//evil.example/p.png)",
    "![t](javascript:alert(1))",
    "![t](data:text/html,<script>alert(1)</script>)",
  ])("drops a tracking-pixel / hostile image: %s", (md) => {
    const html = render(md);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.example");
    expect(html).toContain("t"); // alt text survives
  });

  it("owner-authored (trusted) content may use any host", () => {
    expect(render("![x](https://cdn.example.org/a.png)", true)).toContain("https://cdn.example.org/a.png");
  });

  it("still escapes raw HTML and neutralizes javascript: links", () => {
    const html = render('<script>alert(1)</script> <img src=x onerror=alert(1)> [c](javascript:alert(1))');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/href="javascript:/i);
  });
});
