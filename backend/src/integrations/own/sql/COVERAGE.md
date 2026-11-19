# PostgreSQL and MySQL coverage

Source: no HTTP API; the wire protocols through Bun's built-in `Bun.SQL` (Postgres and MySQL/MariaDB), 2026-11-19.
Issues #266 and #267. Shared code in `own/sql/index.ts`; `own/postgresql` and `own/mysql` are one line each.

## Sign-in

| Method | Status |
| --- | --- |
| Connection string (`postgres://…`, `mysql://…`), TLS by default; `sslmode=disable` / `ssl-mode=DISABLED` only when written; `verify-full` / `VERIFY_IDENTITY` checks the certificate | done |

## Safety

- Every connect looks the host up and refuses loopback, private, link-local (cloud metadata), carrier NAT, unique-local
  and unspecified addresses (`isPrivate` from `link-title.ts`) and our own `DATABASE_URL` host, then connects to the
  looked-up address (TLS name sent separately), so DNS rebinding can't swap it.
- One connection per call, closed after. 30 s per statement (Postgres `statement_timeout`, MySQL `max_execution_time`,
  MariaDB `max_statement_time`) plus a 35 s timer that closes the connection.
- `run_query` / `explain_query` and every lookup run in a READ ONLY transaction, one statement only (any `;` but a
  trailing one is refused), first word SELECT/WITH/TABLE/VALUES/SHOW/EXPLAIN(/DESCRIBE on MySQL); MySQL `INTO OUTFILE` refused.
- At most 1000 rows come back (a cursor on Postgres, `sql_select_limit` on MySQL), with a note when cut.
- The password is cut out of any error message.

## Deliberately left out

| What | Why |
| --- | --- |
| Other databases on the same Postgres server | A Postgres connection is to one database; connect another with its own string |
| LISTEN/NOTIFY, MySQL binlog as instant triggers | Need a connection kept open per automation; polling covers new/changed rows |
| Deleted-row trigger | Nothing to compare against cheaply; a soft-delete column with row_updated covers it |
| COPY / LOAD DATA files | Files on the database server or Emplio's computer; insert_rows takes up to 1000 rows a call |
| SSH tunnels, client certificates | Not built; the database must be reachable from the internet |

## Triggers (polled, `polls/postgresql.ts`, `polls/mysql.ts`)

new_row (by an increasing id or created-at column), row_updated (by an updated-at column), query_result_changed
(a saved read query's answer differs).

## Actions (same for both; * asks first)

run_query, run_statement*, list_schemas, list_tables, list_views, describe_table, table_row_count, sample_rows,
find_rows, insert_rows*, update_rows*, delete_rows*, explain_query, list_functions, database_info
