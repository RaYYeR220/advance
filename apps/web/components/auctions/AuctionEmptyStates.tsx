import { RunningHead } from "@/components/editorial/Folio";
import { TextLink } from "@/components/editorial/Action";
import styles from "./AuctionEmptyStates.module.css";

function Shell({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <section className={styles.page}>
      <RunningHead page={68} title="Auctions" />
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h1 className={styles.title}>{title}</h1>
      {children}
    </section>
  );
}

export function InvalidLoanId({ loanId }: { loanId: string }) {
  return (
    <Shell eyebrow="Not a loan id" title="That doesn't look like a loan id">
      <p className={styles.body}>
        <code>{loanId}</code> isn&apos;t a whole number. Loan ids are assigned in order starting from 1.
      </p>
      <p className={styles.actions}>
        <TextLink href="/auctions">Back to auctions</TextLink>
      </p>
    </Shell>
  );
}

export function AuctionNotFound({ loanId }: { loanId: string }) {
  return (
    <Shell eyebrow="Not found" title={`No loan #${loanId} has opened`}>
      <p className={styles.body}>The hub has never opened a loan with this id, so there is no auction to show.</p>
      <p className={styles.actions}>
        <TextLink href="/auctions">Back to auctions</TextLink>
      </p>
    </Shell>
  );
}

export function AuctionError({ loanId }: { loanId: string }) {
  return (
    <Shell eyebrow="Not available" title="Can't read this auction right now">
      <p className={styles.body}>
        The chain read for loan <code>{loanId}</code> failed partway through — this is usually transient.
      </p>
      <p className={styles.actions}>
        <TextLink href={`/auctions/${loanId}`}>Try again</TextLink> · <TextLink href="/auctions">Back to auctions</TextLink>
      </p>
    </Shell>
  );
}
