// MySQL's polled triggers: the same three as PostgreSQL's (polls/postgresql.ts).
import { sqlPolls } from "./postgresql";

export const mysql = sqlPolls("mysql");
