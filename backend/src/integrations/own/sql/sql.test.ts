// The address guard and statement rules need no database. The rest runs against throwaway local databases only when
// given: SQL_TEST_PG=postgres://me@127.0.0.1:5432/scratch?sslmode=disable SQL_TEST_MYSQL=mysql://root@127.0.0.1:3306/scratch?ssl-mode=DISABLED
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pollOnce } from "../../polls";
import { AppsError } from "../../types";
import { own } from "../index";
import { allowForTests, oneStatement, parseKey, publicAddress, readOnlyQuery, ROW_CAP } from "./index";

const fails = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected it to fail");
    },
    (e: AppsError) => e,
  );
const answers = (map: Record<string, string[]>) => async (h: string) => map[h] ?? [];

describe("address guard", () => {
  test("private, internal and metadata addresses are refused, by IP or by name", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd12::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1"])
      expect((await fails(publicAddress(ip))).message).toContain("private or internal");
    // a public-looking name that points inside (or has one address inside) is refused too
    expect((await fails(publicAddress("db.evil.test", answers({ "db.evil.test": ["169.254.169.254"] })))).message).toContain("private");
    expect((await fails(publicAddress("mixed.test", answers({ "mixed.test": ["8.8.8.8", "10.1.1.1"] })))).message).toContain("private");
  });

  test("a public name answers the address to connect to, IPv4 first", async () => {
    expect(await publicAddress("db.shop.test", answers({ "db.shop.test": ["2606:4700::1", "203.0.114.9"] }))).toBe("203.0.114.9");
    expect(await publicAddress("8.8.8.8")).toBe("8.8.8.8");
  });

  test("a name that doesn't resolve is a clear error", async () => {
    expect((await fails(publicAddress("nowhere.test", answers({}))))).toBeInstanceOf(AppsError);
  });

  test("check refuses a private host before connecting", async () => {
    const e = await fails(own.connectWithKey!("postgresql", "postgres://u:secretpw@127.0.0.1:5432/db"));
    expect(e.message).toContain("private or internal");
    expect(e.message).not.toContain("secretpw");
    expect((await fails(own.connectWithKey!("mysql", "mysql://u:p@169.254.169.254/db"))).message).toContain("private");
  });
});

describe("connection string", () => {
  test("TLS unless explicitly turned off", () => {
    expect(parseKey("postgresql", "postgres://u:p%40ss@db.x.com/shop")).toMatchObject({ host: "db.x.com", port: 5432, user: "u", password: "p@ss", database: "shop", tls: "require" });
    expect(parseKey("postgresql", "postgresql://u:p@db.x.com:6543/shop?sslmode=disable").tls).toBe("disable");
    expect(parseKey("postgresql", "postgres://u:p@db.x.com/shop?sslmode=verify-full").tls).toBe("verify");
    expect(parseKey("postgresql", "postgres://u:p@db.x.com/shop?sslmode=prefer").tls).toBe("require");
    expect(parseKey("mysql", "mysql://u:p@db.x.com/shop?ssl-mode=DISABLED")).toMatchObject({ port: 3306, tls: "disable" });
    expect(parseKey("mysql", "mysql://u:p@db.x.com/shop?ssl-mode=VERIFY_IDENTITY").tls).toBe("verify");
  });
  test("wrong kind or junk is refused", () => {
    expect(() => parseKey("postgresql", "mysql://u:p@h/db")).toThrow("connection string");
    expect(() => parseKey("mysql", "not a url")).toThrow("connection string");
    expect(() => parseKey("mysql", "mysql://u:p%zz@h/db")).toThrow("%-code");
  });
});

describe("statements", () => {
  test("run_query takes one reading statement", () => {
    expect(readOnlyQuery("postgresql", "  -- note\n select * from t;  ")).toBe("-- note\n select * from t");
    expect(readOnlyQuery("postgresql", "with x as (select 1) select * from x")).toContain("with");
    expect(readOnlyQuery("mysql", "show tables")).toBe("show tables");
    for (const q of ["select 1; commit; drop table t", "select 1; delete from t", "select ';'"]) expect(() => oneStatement(q)).toThrow("one statement");
    for (const q of ["delete from t", "/* hi */ update t set a = 1", "set transaction read write", "commit", "drop table t", "call p()"]) expect(() => readOnlyQuery("postgresql", q)).toThrow("only reads");
    expect(() => readOnlyQuery("mysql", "select * from t into outfile '/tmp/x'")).toThrow("files");
  });
  test("reads run unasked, changes ask first", async () => {
    const read = ["run_query", "list_schemas", "list_tables", "list_views", "describe_table", "table_row_count", "sample_rows", "find_rows", "explain_query", "list_functions", "database_info"];
    const ask = ["run_statement", "insert_rows", "update_rows", "delete_rows"];
    for (const app of ["postgresql", "mysql"]) {
      for (const a of read) expect((await own.getAction(`${app}.${a}`))?.readOnly).toBe(true);
      for (const a of ask) expect((await own.getAction(`${app}.${a}`))?.readOnly).toBeFalsy();
    }
  });
});

// --- against real databases, when given ---

for (const [app, env] of [["postgresql", "SQL_TEST_PG"], ["mysql", "SQL_TEST_MYSQL"]] as const) {
  const key = process.env[env];
  describe.skipIf(!key)(`${app} live`, () => {
    const run = (action: string, input: unknown) => own.run(`${app}.${action}`, input, { externalId: "", secret: key! }, "owner") as Promise<any>;
    const auto = app === "postgresql" ? "id serial primary key" : "id int auto_increment primary key";
    beforeAll(async () => {
      allowForTests.add(parseKey(app, key!).host);
      await run("run_statement", { query: "drop table if exists emplio_test_orders" });
      await run("run_statement", { query: `create table emplio_test_orders (${auto}, customer varchar(100) not null, total int, status varchar(20) default 'new')` });
      await run("run_statement", { query: "create index emplio_test_orders_status on emplio_test_orders (status)" });
    });
    afterAll(async () => {
      await run("run_statement", { query: "drop table if exists emplio_test_orders" });
      allowForTests.clear();
    });

    test("connects and labels the connection", async () => {
      expect((await own.connectWithKey!(app, key!)).label).toContain("@127.0.0.1");
      expect((await run("database_info", {})).version).toBeTruthy();
    });

    test("rows in, found, changed, counted, deleted", async () => {
      const ins = await run("insert_rows", { table: "emplio_test_orders", rows: [{ customer: "Asha", total: 500 }, { customer: "Ravi", total: 1200, status: "paid" }] });
      expect(ins.affected_rows).toBe(2);
      const found = await run("find_rows", { table: "emplio_test_orders", filters: [{ column: "total", op: ">", value: 600 }] });
      expect(found.rows).toHaveLength(1);
      expect(found.rows[0].customer).toBe("Ravi");
      expect((await run("find_rows", { table: "emplio_test_orders", filters: [{ column: "customer", op: "in", value: ["Asha", "Nobody"] }] })).rows).toHaveLength(1);
      expect((await run("find_rows", { table: "emplio_test_orders", filters: [{ column: "customer", op: "ilike", value: "asha" }] })).rows).toHaveLength(1);
      expect((await run("update_rows", { table: "emplio_test_orders", set: { status: "shipped" }, filters: [{ column: "customer", value: "Asha" }] })).affected_rows).toBe(1);
      expect((await run("table_row_count", { table: "emplio_test_orders", filters: [{ column: "status", value: "shipped" }] })).count).toBe(1);
      expect((await run("delete_rows", { table: "emplio_test_orders", filters: [{ column: "customer", value: "Ravi" }] })).affected_rows).toBe(1);
      expect((await run("sample_rows", { table: "emplio_test_orders" })).rows).toHaveLength(1);
    });

    test("describes tables, columns, keys and indexes", async () => {
      expect((await run("list_tables", {})).rows.some((t: any) => t.table === "emplio_test_orders")).toBe(true);
      const d = await run("describe_table", { table: "emplio_test_orders" });
      expect(d.columns.map((c: any) => c.column)).toEqual(["id", "customer", "total", "status"]);
      expect(d.constraints.some((c: any) => c.type === "primary key")).toBe(true);
      expect(d.indexes.some((i: any) => i.name === "emplio_test_orders_status")).toBe(true);
      expect((await fails(run("describe_table", { table: "no_such_table" }))).message).toContain("no table");
      for (const a of ["list_schemas", "list_views", "list_functions"]) expect(Array.isArray((await run(a, {})).rows)).toBe(true);
      expect(await run("explain_query", { query: "select * from emplio_test_orders where status = 'new'" })).toBeTruthy();
    });

    test("run_query can't write, even through tricks, and is capped", async () => {
      await fails(run("run_query", { query: "delete from emplio_test_orders" }));
      // a reading statement that writes anyway is stopped by the read-only transaction
      const sneaky = app === "postgresql" ? "with d as (delete from emplio_test_orders returning *) select * from d" : "select * from emplio_test_orders for update";
      if (app === "postgresql") await fails(run("run_query", { query: sneaky }));
      const big = app === "postgresql" ? "select g from generate_series(1, 5000) g" : "select 1 as g from information_schema.columns a cross join information_schema.columns b limit 5000";
      const out = await run("run_query", { query: big });
      expect(out.rows).toHaveLength(ROW_CAP);
      expect(out.note).toContain(`first ${ROW_CAP}`);
      expect((await run("run_query", { query: `select count(*) as n from emplio_test_orders where customer = ${app === "postgresql" ? "$1" : "?"}`, params: ["Asha"] })).rows[0].n).toBeTruthy();
    });

    test("polled triggers: new row, changed row, changed answer", async () => {
      const runner = (a: string, i: unknown) => own.run(a, i, { externalId: "", secret: key! }, "owner");
      const first = await pollOnce(`${app}.new_row`, { table: "emplio_test_orders", column: "id" }, null, runner);
      await run("insert_rows", { table: "emplio_test_orders", rows: [{ customer: "Meena", total: 50 }] });
      const next = await pollOnce(`${app}.new_row`, { table: "emplio_test_orders", column: "id" }, first.seen, runner);
      expect(next.fresh).toHaveLength(1);
      expect((next.fresh[0] as any).row.customer).toBe("Meena");
      const q = { query: "select customer, total from emplio_test_orders order by id" };
      const a = await pollOnce(`${app}.query_result_changed`, q, null, runner);
      expect((await pollOnce(`${app}.query_result_changed`, q, a.seen, runner)).fresh).toHaveLength(0);
      await run("update_rows", { table: "emplio_test_orders", set: { total: 99 }, filters: [{ column: "customer", value: "Meena" }] });
      expect((await pollOnce(`${app}.query_result_changed`, q, a.seen, runner)).fresh).toHaveLength(1);
    });
  });
}
