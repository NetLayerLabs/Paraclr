"use client";

import { useId, useState } from "react";
import { ArrowUpRight } from "./icons";
import s from "./AddressPager.module.css";

export interface PagerRow {
  name: string;
  role: string;
  address: string;
  external: boolean;
}

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-4)}`;

/**
 * A deployment's contract / role addresses, a few per page. The server renders page 1, so without JS the first page
 * and the link to the full list in the README are still there.
 */
export function AddressPager({
  rows,
  explorer,
  label,
  perPage = 4,
}: {
  rows: PagerRow[];
  explorer: string;
  label: string;
  perPage?: number;
}) {
  const pages = Math.max(1, Math.ceil(rows.length / perPage));
  const [page, setPage] = useState(0);
  // Clamp, so a shorter list after a rebuild never leaves an empty page.
  const p = Math.min(page, pages - 1);
  const listId = useId();
  const first = p * perPage;
  const shown = rows.slice(first, first + perPage);

  return (
    <div className={s.pager} role="region" aria-label={label}>
      <ul id={listId} className={s.addrList} style={{ minHeight: `${perPage * 4.25}rem` }}>
        {shown.map((c) => (
          <li key={`${c.name}-${c.address}`}>
            <span className={s.cWho}>
              <span className={s.cName}>
                {c.name}
                {c.external ? <span className={s.extTag}>external</span> : null}
              </span>
              {c.role ? <span className={s.cRole}>{c.role}</span> : null}
            </span>
            <a
              className={s.addr}
              href={`${explorer}/address/${c.address}`}
              target="_blank"
              rel="noreferrer"
              title={c.address}
              aria-label={`${c.name} ${c.address} on the explorer`}
            >
              {short(c.address)}
              <ArrowUpRight className={s.addrIcon} />
            </a>
          </li>
        ))}
      </ul>
      {pages > 1 ? (
        <div className={s.pagerNav}>
          <button
            type="button"
            className={s.pagerBtn}
            onClick={() => setPage(p - 1)}
            disabled={p === 0}
            aria-controls={listId}
            aria-label="Previous addresses"
          >
            Previous
          </button>
          <span className={s.pagerCount} aria-live="polite">
            <span className={s.srOnly}>Page </span>
            {p + 1} / {pages}
            <span className={s.srOnly}>
              , addresses {first + 1} to {first + shown.length} of {rows.length}
            </span>
          </span>
          <button
            type="button"
            className={s.pagerBtn}
            onClick={() => setPage(p + 1)}
            disabled={p === pages - 1}
            aria-controls={listId}
            aria-label="Next addresses"
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
