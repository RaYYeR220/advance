import { RunningHead } from "@/components/editorial/Folio";
import { TextLink } from "@/components/editorial/Action";
import styles from "./DocsIndex.module.css";

/** `/docs/[slug]` for a doc that isn't recognized, or whose file doesn't exist in this
 * checkout yet — an honest "not published yet", never a bare 404 or a broken link followed
 * from the index. */
export function DocNotFound({ slug }: { slug: string }) {
  return (
    <section className={styles.page}>
      <RunningHead page={96} title="Docs" />
      <p className={styles.eyebrow}>Not published yet</p>
      <h1 className={styles.title}>This doc isn&apos;t written yet</h1>
      <p className={styles.sectionIntro}>
        <code>{slug}</code> isn&apos;t one of the repository&apos;s docs, or its file doesn&apos;t exist in this
        checkout yet.
      </p>
      <p className={styles.sectionIntro}>
        <TextLink href="/docs">Back to docs</TextLink>
      </p>
    </section>
  );
}
