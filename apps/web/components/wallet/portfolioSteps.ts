import { zeroAddress, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { revenueNoteAbi, type LoanView } from "@advance/sdk";
import type { NoteRead } from "@/lib/portfolio";

/**
 * The connected lender's own note reads and claim write — direct `revenueNote` calls, the same
 * way `bidSteps.ts` reimplements the auction's bid flow rather than going through
 * `AdvanceClient` (whose `claim` needs a hub read to find the note address this module already
 * has from the loan list the server already passed down).
 */

/** `balanceOf`/`claimable` for `holder`, across every loan — a loan whose note was never
 * deployed (`status` `None`) reads as zero on both without a chain call. */
export async function readNoteHoldings(
  publicClient: PublicClient,
  loans: readonly LoanView[],
  holder: Address,
): Promise<NoteRead[]> {
  return Promise.all(
    loans.map(async (loan): Promise<NoteRead> => {
      if (loan.note === zeroAddress) return { loan, balance: 0n, claimable: 0n };
      const [balance, claimable] = await Promise.all([
        publicClient.readContract({ address: loan.note, abi: revenueNoteAbi, functionName: "balanceOf", args: [holder] }) as Promise<bigint>,
        publicClient.readContract({ address: loan.note, abi: revenueNoteAbi, functionName: "claimable", args: [holder] }) as Promise<bigint>,
      ]);
      return { loan, balance, claimable };
    }),
  );
}

/** Claims the connected wallet's owed USDC from one loan's revenue note. */
export async function claimNote(wallet: WalletClient, publicClient: PublicClient, note: Address): Promise<{ hash: Hex; amount: bigint }> {
  const account = wallet.account;
  if (!account) throw new Error("Connected wallet has no account.");
  const { request, result } = await publicClient.simulateContract({
    address: note,
    abi: revenueNoteAbi,
    functionName: "claim",
    account,
    chain: wallet.chain,
  });
  const hash = await wallet.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash, amount: result };
}
