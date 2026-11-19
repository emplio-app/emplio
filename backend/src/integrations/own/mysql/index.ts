// A business's own MySQL (or MariaDB) database, connected with its connection string. Everything lives in own/sql.
import { sqlApp } from "../sql";

export const mysql = sqlApp("mysql");
