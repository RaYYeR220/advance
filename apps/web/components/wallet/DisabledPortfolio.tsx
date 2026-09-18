import shared from "./BidPanel.module.css";

/** The connected-wallet panel's disabled state, used whenever `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID`
 * isn't configured — mirrors `DisabledBidForm`'s own explanation for the same missing
 * environment. */
export function DisabledPortfolio() {
  return (
    <div className={shared.form}>
      <p className={shared.copy}>Connect a lender wallet to see the notes you hold, what&apos;s claimable, and your repayment history.</p>
      <button type="button" className="button" disabled>
        Connect wallet
      </button>
      <p className={shared.explain}>
        Reading your notes needs a configured wallet environment. Set <code>NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID</code> to
        enable it.
      </p>
    </div>
  );
}
