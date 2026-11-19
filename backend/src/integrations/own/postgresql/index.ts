// A business's own PostgreSQL database, connected with its connection string. Everything lives in own/sql.
import { sqlApp } from "../sql";

export const postgresql = sqlApp("postgresql");
