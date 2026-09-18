import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, splitLeadingHeading } from "@/lib/markdown";

describe("parseMarkdown", () => {
  it("parses headings at every supported level", () => {
    expect(parseMarkdown("# One\n## Two\n### Three")).toEqual([
      { type: "heading", level: 1, text: "One" },
      { type: "heading", level: 2, text: "Two" },
      { type: "heading", level: 3, text: "Three" },
    ]);
  });

  it("joins consecutive lines into one paragraph, split on a blank line", () => {
    const nodes = parseMarkdown("First line\nsecond line.\n\nA new paragraph.");
    expect(nodes).toEqual([
      { type: "paragraph", text: "First line second line." },
      { type: "paragraph", text: "A new paragraph." },
    ]);
  });

  it("parses an unordered list", () => {
    const nodes = parseMarkdown("- one\n- two\n- three");
    expect(nodes).toEqual([{ type: "list", ordered: false, items: ["one", "two", "three"] }]);
  });

  it("parses an ordered list", () => {
    const nodes = parseMarkdown("1. first\n2. second");
    expect(nodes).toEqual([{ type: "list", ordered: true, items: ["first", "second"] }]);
  });

  it("folds an indented continuation line into the previous list item", () => {
    const nodes = parseMarkdown("- one\n  more of one\n- two");
    expect(nodes).toEqual([{ type: "list", ordered: false, items: ["one more of one", "two"] }]);
  });

  it("parses a fenced code block, keeping its language and exact text", () => {
    const nodes = parseMarkdown("```bash\npnpm install\ncd contracts\n```");
    expect(nodes).toEqual([{ type: "code", lang: "bash", text: "pnpm install\ncd contracts" }]);
  });

  it("parses a fenced code block with no language", () => {
    const nodes = parseMarkdown("```\nplain\n```");
    expect(nodes).toEqual([{ type: "code", lang: undefined, text: "plain" }]);
  });

  it("parses a pipe table", () => {
    const source = "| Claim | Where |\n|---|---|\n| A | B |\n| C | D |";
    const nodes = parseMarkdown(source);
    expect(nodes).toEqual([
      {
        type: "table",
        header: ["Claim", "Where"],
        rows: [
          ["A", "B"],
          ["C", "D"],
        ],
      },
    ]);
  });

  it("parses a whole document with mixed blocks in order", () => {
    const source = [
      "# Title",
      "",
      "Intro paragraph.",
      "",
      "- bullet one",
      "- bullet two",
      "",
      "## Section",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
    ].join("\n");
    const nodes = parseMarkdown(source);
    expect(nodes.map((n) => n.type)).toEqual(["heading", "paragraph", "list", "heading", "table"]);
  });

  it("returns an empty list for empty input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n\n")).toEqual([]);
  });
});

describe("splitLeadingHeading", () => {
  it("pulls off a leading level-1 heading as the title", () => {
    const nodes = parseMarkdown("# Title\n\nBody.");
    expect(splitLeadingHeading(nodes)).toEqual({ title: "Title", body: [{ type: "paragraph", text: "Body." }] });
  });

  it("leaves everything as the body when there is no leading level-1 heading", () => {
    const nodes = parseMarkdown("## Section\n\nBody.");
    expect(splitLeadingHeading(nodes)).toEqual({ title: undefined, body: nodes });
  });

  it("leaves everything as the body for an empty document", () => {
    expect(splitLeadingHeading([])).toEqual({ title: undefined, body: [] });
  });
});

describe("parseInline", () => {
  it("splits plain, bold and code runs in order", () => {
    expect(parseInline("plain **bold** and `code` end")).toEqual([
      { kind: "text", text: "plain " },
      { kind: "bold", text: "bold" },
      { kind: "text", text: " and " },
      { kind: "code", text: "code" },
      { kind: "text", text: " end" },
    ]);
  });

  it("returns a single text token when there is no inline markup", () => {
    expect(parseInline("just text")).toEqual([{ kind: "text", text: "just text" }]);
  });

  it("handles bold at the very start and code at the very end", () => {
    expect(parseInline("**bold** middle `code`")).toEqual([
      { kind: "bold", text: "bold" },
      { kind: "text", text: " middle " },
      { kind: "code", text: "code" },
    ]);
  });
});
