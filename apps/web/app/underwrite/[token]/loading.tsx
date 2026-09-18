import { Masthead } from "@/components/editorial/Masthead";
import { RunningHead } from "@/components/editorial/Folio";
import { NAV } from "@/lib/nav";
import styles from "@/components/underwrite/ScoreResult.module.css";

/** Shown while the score's server component awaits `getScore` — no chrome missing, just the
 * numbers not there yet. */
export default function Loading() {
  return (
    <>
      <Masthead links={NAV} />
      <main id="main">
        <section className={styles.page} aria-busy="true">
          <RunningHead page={61} title="Score" />
          <p className={styles.eyebrow}>Reading the fee stream</p>
          <h1 className={styles.title}>Scoring this token…</h1>
          <p className={styles.body}>Pulling revenue windows from Base archive reads. This usually takes a few seconds.</p>
        </section>
      </main>
    </>
  );
}
