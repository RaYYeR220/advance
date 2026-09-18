import { RunningHead } from "@/components/editorial/Folio";
import { TextLink } from "@/components/editorial/Action";
import { parseMarkdown, splitLeadingHeading } from "@/lib/markdown";
import { Markdown } from "./Markdown";
import styles from "./DocsIndex.module.css";

export interface DocViewProps {
  fallbackTitle: string;
  source: string;
}

/** One repository doc (`docs/CLAIMS.md` and friends), rendered as a real page — the document's
 * own leading heading becomes the page's `<h1>`, everything after it renders in order. */
export function DocView({ fallbackTitle, source }: DocViewProps) {
  const { title, body } = splitLeadingHeading(parseMarkdown(source));

  return (
    <section className={styles.page}>
      <RunningHead page={96} title="Docs" />
      <p className={styles.eyebrow}>From the repository</p>
      <h1 className={styles.title}>{title ?? fallbackTitle}</h1>
      <Markdown nodes={body} />
      <p className={styles.backLink}>
        <TextLink href="/docs">Back to docs</TextLink>
      </p>
    </section>
  );
}
