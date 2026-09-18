"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/lib/cx";
import { isAddress } from "@/lib/format";
import styles from "./UnderwriteForm.module.css";

/** Paste-a-token form: validates the address client-side and navigates to its score page.
 * Never calls the underwriter itself — `/underwrite/[token]` does the real read, server-side. */
export function UnderwriteForm() {
  const router = useRouter();
  const inputId = useId();
  const errorId = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = value.trim();
    if (!isAddress(token)) {
      setError("That doesn't look like a token address. It should start with 0x and have 40 hex characters after it.");
      return;
    }
    setError(null);
    router.push(`/underwrite/${token}`);
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <label className={styles.label} htmlFor={inputId}>
        Token address
      </label>
      <div className={styles.row}>
        <input
          id={inputId}
          className={styles.input}
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="0x…"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        <button type="submit" className={cx("button", styles.submit)}>
          Score this token
        </button>
      </div>
      {error ? (
        <p className={styles.error} id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
