import { Fragment } from "react";
import { parseInline, type MdNode } from "@/lib/markdown";
import styles from "./Markdown.module.css";

/** Renders the subset of parsed markdown `lib/markdown.ts` supports as plain, editorial HTML —
 * no new visual language: headings, paragraphs and code reuse the page's own type scale. */
export function Markdown({ nodes }: { nodes: readonly MdNode[] }) {
  return (
    <div className={styles.doc}>
      {nodes.map((node, i) => (
        <Block key={i} node={node} />
      ))}
    </div>
  );
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((token, i) => {
        if (token.kind === "bold") return <b key={i}>{token.text}</b>;
        if (token.kind === "code") return <code key={i}>{token.text}</code>;
        return <Fragment key={i}>{token.text}</Fragment>;
      })}
    </>
  );
}

function Block({ node }: { node: MdNode }) {
  switch (node.type) {
    case "heading": {
      const Tag = `h${node.level}` as const;
      return (
        <Tag>
          <Inline text={node.text} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p>
          <Inline text={node.text} />
        </p>
      );
    case "list": {
      const List = node.ordered ? "ol" : "ul";
      return (
        <List>
          {node.items.map((item, i) => (
            <li key={i}>
              <Inline text={item} />
            </li>
          ))}
        </List>
      );
    }
    case "code":
      return (
        <pre>
          <code>{node.text}</code>
        </pre>
      );
    case "table":
      return (
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                {node.header.map((cell, i) => (
                  <th key={i} scope="col">
                    <Inline text={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>
                      <Inline text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}
