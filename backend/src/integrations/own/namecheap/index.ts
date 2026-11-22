// Namecheap on the business's own API key: every command of Namecheap's API — domains (list, register, renew,
// reactivate, contacts, lock), DNS records and nameservers, email forwarding, transfers in, SSL certificates,
// domain privacy, balance and pricing, saved addresses and sub-accounts. Namecheap has no OpenAPI spec and
// answers in XML, so the commands are listed by hand and client.ts turns the XML into JSON; COVERAGE.md says what's where.
import type { OwnApp } from "../index";
import { accountActions } from "./account";
import { ipText, nc, parseKey } from "./client";
import { dnsActions } from "./dns";
import { domainActions } from "./domains";
import { sslActions } from "./ssl";

export const namecheap: OwnApp = {
  app: "namecheap",
  name: "Namecheap",
  logo: "/logos/namecheap.svg",
  keyField: {
    label: "Username and API key",
    // a getter: the address comes from the server's settings, read when the dialog asks
    get help() {
      return `In Namecheap go to Profile → Tools → Namecheap API Access and switch API access ON (Namecheap only allows it once the account has $50 in its balance or $50 spent in the last 2 years, or 20+ domains). ` +
      `Then, on the same page, under Whitelisted IPs click Edit and add ${ipText()}, Emplio's server, or Namecheap will refuse every request. ` +
      `Then copy the API key.`;
    },
    placeholder: "myusername:0123456789abcdef0123456789abcdef",
    sep: ":",
    parts: [{label:"Username",placeholder:"myusername"},{label:"API key",secret:true,placeholder:"0123456789abcdef0123456789abcdef"}],
  },
  // the balance: cheap, and it fails clearly on a wrong key, API access off, or our IP missing from the allow-list
  async check(key) {
    const { userName } = parseKey(key);
    await nc(key, "namecheap.users.getBalances");
    return userName;
  },
  actions: { ...domainActions, ...dnsActions, ...sslActions, ...accountActions },
};
